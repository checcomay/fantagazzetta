import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import stringSimilarity from 'string-similarity';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== PATH CONFIGURATION ====================
const SQUADS_PATH = path.resolve(__dirname, '../src/data/squads.json');
const LINEUPS_PROB_PATH = path.resolve(__dirname, '../src/data/prob_indeces.json');
const OUTFIELD_ODDS_PATH = path.resolve(__dirname, '../src/data/daily_odds.json');
const GK_ODDS_PATH = path.resolve(__dirname, '../src/data/daily_gk_odds.json');
const OUTPUT_PATH = path.resolve(__dirname, '../src/data/xFMs.json');

// ==================== 1. BONUS & MALUS REGOLAMENTO ====================
const GOAL_BONUS = 3.0;                     // +3 per ogni gol segnato
const BRACE_BONUS = 3.0;                    // +3 addizionali per la doppietta
const ASSIST_BONUS = 1.0;                   // +1 per ogni assist
const CLEAN_SHEET_BONUS = 1.0;              // +1 imbattibilità portiere
const GOAL_CONCEDED_MALUS = 1.0;            // -1 per ogni gol subito dal portiere
const YELLOW_CARD_MALUS = 0.5;              // -0.5 ammonizione
const RED_CARD_MALUS = 1.0;                 // -1.0 espulsione
const OWN_GOAL_MALUS = 2.0;                 // -2.0 autogol
const DEFENSE_MODIFIER_BONUS = 1.5;         // +1.5 bonus medio modificatore difesa (per difese a 4 o 5)

// ==================== 2. OSCILLAZIONE VOTO PAGELLA ====================
const BASE_RATING = 6.0;                    // Voto di partenza standard
const GK_CS_RATING_BOOST = 0.25;            // Aumento voto puro portiere in caso di clean sheet
const GK_CONCEDED_RATING_MALUS = 0.15;      // Calo voto puro portiere per gol subito
const GOAL_RATING_BOOST = 0.35;             // Aumento voto puro giocatore in caso di gol
const ASSIST_RATING_BOOST = 0.20;           // Aumento voto puro giocatore in caso di assist
const YELLOW_RATING_MALUS = 0.25;           // Calo voto puro giocatore per cartellino giallo
const RED_RATING_MALUS = 0.50;              // Calo voto puro giocatore per cartellino rosso

// ==================== 2.1. PROFILI DINAMICI PER RUOLO ====================
// Rimodula default statistici, rischio cartellini/autogol e impatto da subentrante per ruolo
const ROLE_PROFILES = {
  P: {
    defaultCleanSheetProb: 25,
    defaultGoalsConceded: 1.35,
    defaultYellowProb: 4,
    defaultRedProb: 0.5,
    ownGoalProb: 1.0,         // 1.0% rischio autogol portiere (deviazioni su pali/traverse)
    cardRiskMultiplier: 1.0,
    subImpactBoost: 0.05      // Un portiere in panchina subentra raramente
  },
  D: {
    defaultGoalProb: 2,       // Fallback realistico per difensori non quotati
    defaultBraceProb: 0.1,
    defaultAssistProb: 4,
    defaultYellowProb: 22,    // Maggior probabilità di ammonizione per i difensori
    defaultRedProb: 2.0,      // Maggior rischio espulsione (fallo da ultimo uomo / doppia amm.)
    ownGoalProb: 2.0,         // 2.0% rischio autogol per i difensori
    cardRiskMultiplier: 1.15, // Peso specifico malus disciplinare (+15% per i difensori)
    subImpactBoost: 0.25      // Impatto bonus contenuto se parte dalla panchina
  },
  C: {
    defaultGoalProb: 5,
    defaultBraceProb: 0.5,
    defaultAssistProb: 8,
    defaultYellowProb: 18,    // Mediani/centrocampisti soggetti a falli tattici
    defaultRedProb: 1.2,
    ownGoalProb: 0.8,         // 0.8% rischio autogol
    cardRiskMultiplier: 1.05, // Peso specifico malus disciplinare (+5% per i centrocampisti)
    subImpactBoost: 0.45      // Buon impatto da subentrante negli ultimi 25-30 minuti
  },
  A: {
    defaultGoalProb: 12,
    defaultBraceProb: 2.0,
    defaultAssistProb: 8,
    defaultYellowProb: 10,    // Minor rischio cartellini per gli attaccanti
    defaultRedProb: 0.5,
    ownGoalProb: 0.2,         // Rischio autogol quasi nullo (0.2%)
    cardRiskMultiplier: 0.85, // Minor penalizzazione disciplinare
    subImpactBoost: 0.60      // Alto potenziale di bonus anche da subentrante (difese stanche)
  }
};

const DEFAULT_STARTER_PROB = 10;

// ==================== 2.3. MODULI LEGALI FANTACALCIO ====================
const LEGAL_FORMATIONS = [
  { name: '3-4-3', roles: { P: 1, D: 3, C: 4, A: 3 }, hasDefenseModifier: false },
  { name: '3-5-2', roles: { P: 1, D: 3, C: 5, A: 2 }, hasDefenseModifier: false },
  { name: '4-3-3', roles: { P: 1, D: 4, C: 3, A: 3 }, hasDefenseModifier: true },
  { name: '4-4-2', roles: { P: 1, D: 4, C: 4, A: 2 }, hasDefenseModifier: true },
  { name: '4-5-1', roles: { P: 1, D: 4, C: 5, A: 1 }, hasDefenseModifier: true },
  { name: '5-3-2', roles: { P: 1, D: 5, C: 3, A: 2 }, hasDefenseModifier: true },
  { name: '5-4-1', roles: { P: 1, D: 5, C: 4, A: 1 }, hasDefenseModifier: true }
];

// ==================== HELPER DI NORMALIZZAZIONE E MATCHING PROTETTO ====================

const TEAM_ALIASES = {
  'internazionale': 'inter',
  'inter milan': 'inter',
  'ac milan': 'milan',
  'hellas verona': 'verona',
  'as roma': 'roma',
  'ss lazio': 'lazio',
  'atalanta bc': 'atalanta',
  'juventus fc': 'juventus'
};

function normalizeTeam(teamName) {
  if (!teamName) return '';
  const clean = teamName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
  return TEAM_ALIASES[clean] || clean;
}

function normalizeName(name, keepInitials = false) {
  if (!name) return '';
  let str = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (!keepInitials) {
    str = str.replace(/\b[a-z]{1,2}\.(?:\s*[a-z]{1,2}\.)*/g, '');
  }

  return str
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractInitial(name) {
  if (!name) return null;
  const match = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .match(/\b([a-zA-Z]{1,2})\.(?:\s*[a-zA-Z]{1,2}\.)*$/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Matching protetto per ID, Nome, Ruolo e Squadra di Serie A.
 * Impedisce che un difensore (es. "Ramon" del Como) agganci le quote di un attaccante (es. "Ramos G." del Milan).
 */
function findPlayerMatch(player, datasetList) {
  if (!datasetList || datasetList.length === 0 || !player) return null;

  const targetId = String(player.id || '');
  const targetNormFull = normalizeName(player.nome, true);
  const targetNormBase = normalizeName(player.nome, false);
  const targetInitial = extractInitial(player.nome);
  const targetRole = (player.ruolo || '').toUpperCase();
  const targetTeam = normalizeTeam(player.squadraSerieA);

  // 1. MATCH DETERMINISTICO PER ID UNIVOCO
  if (targetId) {
    const idMatch = datasetList.find((item) => String(item.id || '') === targetId);
    if (idMatch) return idMatch;
  }

  // 2. MATCH PER NOME ESATTO COMPLETO (CON INIZIALI) + RUOLO E SQUADRA COMPATIBILI
  const exactFullMatch = datasetList.find((item) => {
    const itemNormFull = normalizeName(item.nome || item.name, true);
    const itemRole = (item.ruolo || item.role || '').toUpperCase();
    const itemTeam = normalizeTeam(item.squadra_reale || item.squadra_serie_a || item.real_team);

    const roleOk = !itemRole || itemRole === targetRole;
    const teamOk = !itemTeam || !targetTeam || itemTeam.includes(targetTeam) || targetTeam.includes(itemTeam);
    return itemNormFull === targetNormFull && roleOk && teamOk;
  });
  if (exactFullMatch) return exactFullMatch;

  // 3. FILTRO CANDIDATI COMPATIBILI PER RUOLO, SQUADRA E INIZIALE
  const compatibleCandidates = datasetList.filter((item) => {
    const itemRawName = item.nome || item.name || '';
    const itemRole = (item.ruolo || item.role || '').toUpperCase();
    const itemTeam = normalizeTeam(item.squadra_reale || item.squadra_serie_a || item.real_team);
    const itemInitial = extractInitial(itemRawName);

    const isSameRole = !itemRole || itemRole === targetRole;
    const isSameTeam = !itemTeam || !targetTeam || itemTeam.includes(targetTeam) || targetTeam.includes(itemTeam);

    // Se uno dei due ha un'iniziale puntata (es. "Ramos G." vs "Ramon"), devono coincidere
    let isInitialCompatible = true;
    if (targetInitial && itemInitial) {
      isInitialCompatible = targetInitial.startsWith(itemInitial) || itemInitial.startsWith(targetInitial);
    } else if (targetInitial || itemInitial) {
      // Se un nome ha l'iniziale e l'altro no, li accettiamo solo se il cognome base è identico al 100%
      const itemNormBase = normalizeName(itemRawName, false);
      isInitialCompatible = itemNormBase === targetNormBase;
    }

    return isSameRole && isSameTeam && isInitialCompatible;
  });

  if (compatibleCandidates.length === 0) return null;

  // 4. FUZZY MATCH PROTETTO CON SOGLIA DINAMICA PER COGNOMI CORTI (<= 5 LETTERE)
  const candidateNames = compatibleCandidates.map((c) => normalizeName(c.nome || c.name, false));
  const matchResult = stringSimilarity.findBestMatch(targetNormBase, candidateNames);
  const bestScore = matchResult.bestMatch.rating;
  const bestItem = compatibleCandidates[matchResult.bestMatchIndex];
  const bestNormBase = candidateNames[matchResult.bestMatchIndex];

  // Guardia esplicita anti-collisione Ramon / Ramos
  if (
    (targetNormBase === 'ramon' && bestNormBase.includes('ramos')) ||
    (targetNormBase.includes('ramos') && bestNormBase === 'ramon')
  ) {
    return null;
  }

  // Per cognomi corti (<= 5 lettere) serve almeno 0.88; altrimenti 0.72
  const minLength = Math.min(targetNormBase.length, bestNormBase.length);
  const minThreshold = minLength <= 5 ? 0.88 : 0.72;

  if (bestScore >= minThreshold) {
    return bestItem;
  }

  return null;
}

// ==================== 2.2. MODELLO MINUTAGGIO E SUBENTRO ====================

/**
 * Bilancia le probabilità dei bookmaker (che assumono il giocatore titolare) con il minutaggio atteso
 * e l'impatto da subentrante senza penalizzare in modo punitivo il voto base (6.0).
 */
function computeRealisticPlayingWeights(startProb, lineupStatus, roleProfile) {
  // I bookmaker quotano assumendo ~85-90 minuti.
  // Se il giocatore è in ballottaggio (es. 50-60%) o parte dalla panchina,
  // ha comunque un'alta probabilità di subentrare e incidere nei minuti finali.
  const subBonusFactor = roleProfile.subImpactBoost || 0.35;

  // Moltiplicatore di aspettativa sui BONUS (gol, assist):
  // Un titolare al 90% conserva quasi il 95% del potenziale bonus;
  // un giocatore in ballottaggio al 55% conserva ~75% del potenziale (tra titolarità e subentro d'impatto).
  const bonusMinutesMultiplier = Math.min(1.0, startProb + (1 - startProb) * subBonusFactor);

  // Moltiplicatore sui MALUS (cartellini):
  // Chi entra dalla panchina per 20 minuti prende meno cartellini rispetto a chi gioca 90 minuti.
  const penaltyMinutesMultiplier = Math.min(1.0, startProb + (1 - startProb) * 0.25);

  // Peso sul voto base: al Fantacalcio non giochi in 10 se una riserva non entra (entra il sostituto da ~6.0).
  // Applichiamo solo un leggerissimo sconto di continuità (max 4-5%) per chi ha bassa probabilità di voto,
  // così che a parità di bonus un titolare fisso sia sempre preferito a una riserva.
  const baseAvailabilityFactor = 0.95 + 0.05 * startProb;

  return {
    bonusMinutesMultiplier,
    penaltyMinutesMultiplier,
    baseAvailabilityFactor
  };
}

// ==================== 2.3. MOTORE MIGLIOR MODULO (BEST LINEUP OPTIMIZER) ====================

/**
 * Testa tutti i 7 moduli legali del Fantacalcio e restituisce:
 * - il modulo matematicamente ottimale (che massimizza il punteggio totale atteso)
 * - l'undici titolare corrispondente
 * - la classifica completa di tutti i moduli testati per la UI
 */
function optimizeTeamFormation(enrichedRoster) {
  // 1. Filtra via chi ha 0% di probabilità di giocare (es. infortunati / indisponibili con prob 0)
  const availablePlayers = enrichedRoster.filter((p) => (p.starter_probability ?? 0) > 0);

  // 2. GESTIONE GERARCHIA PORTIERI PER SQUADRA REALE:
  // Tra i portieri della stessa squadra di Serie A, seleziona quello con la probabilità di titolarità più alta
  const goalkeepers = availablePlayers.filter((p) => (p.role || '').toUpperCase() === 'P');
  const gkByRealTeam = new Map();
  for (const gk of goalkeepers) {
    const team = gk.real_team;
    if (!gkByRealTeam.has(team) || gk.starter_probability > gkByRealTeam.get(team).starter_probability) {
      gkByRealTeam.set(team, gk);
    }
  }
  const validGks = Array.from(gkByRealTeam.values());

  const getSortedByRole = (role) => {
    if (role === 'P') {
      return validGks.sort((a, b) => b.expected_fantasy_rating - a.expected_fantasy_rating);
    }
    return availablePlayers
      .filter((p) => (p.role || '').toUpperCase() === role)
      .sort((a, b) => b.expected_fantasy_rating - a.expected_fantasy_rating);
  };

  const goalkeepersSorted = getSortedByRole('P');
  const defenders = getSortedByRole('D');
  const midfielders = getSortedByRole('C');
  const attackers = getSortedByRole('A');

  const formationsResults = [];

  for (const mod of LEGAL_FORMATIONS) {
    const pickedP = goalkeepersSorted.slice(0, mod.roles.P);
    const pickedD = defenders.slice(0, mod.roles.D);
    const pickedC = midfielders.slice(0, mod.roles.C);
    const pickedA = attackers.slice(0, mod.roles.A);

    const lineup = [...pickedP, ...pickedD, ...pickedC, ...pickedA];

    if (lineup.length < 11) continue;

    const playersSum = lineup.reduce((acc, p) => acc + p.expected_fantasy_rating, 0);
    const modifierBonus = mod.hasDefenseModifier ? DEFENSE_MODIFIER_BONUS : 0.0;
    const totalScore = Number((playersSum + modifierBonus).toFixed(2));

    formationsResults.push({
      formation: mod.name,
      projected_score: totalScore,
      players_sum: Number(playersSum.toFixed(2)),
      defense_modifier_bonus: modifierBonus,
      lineup
    });
  }

  formationsResults.sort((a, b) => b.projected_score - a.projected_score);

  const best = formationsResults[0] || {
    formation: '4-3-3',
    projected_score: 0,
    defense_modifier_bonus: DEFENSE_MODIFIER_BONUS,
    lineup: []
  };

  return {
    bestFormation: best.formation,
    bestScore: best.projected_score,
    bestModifierBonus: best.defense_modifier_bonus,
    bestLineup: best.lineup,
    allFormations: formationsResults.map((f) => ({
      formation: f.formation,
      projected_score: f.projected_score,
      defense_modifier_bonus: f.defense_modifier_bonus,
      starting_eleven: f.lineup.map((p) => p.name)
    }))
  };
}

// Lettura tollerante dei file JSON
async function readJsonSafe(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.warn(`⚠️ Warning: Could not read ${path.basename(filePath)}. Treating as empty.`);
    return [];
  }
}

// ==================== MAIN EXECUTION ====================

async function main() {
  console.log('📊 Calculating Expected Match Fantasy Ratings (xFM) & Best Lineup Optimizer...');

  const [squads, lineupsData, outfieldData, gkData] = await Promise.all([
    readJsonSafe(SQUADS_PATH),
    readJsonSafe(LINEUPS_PROB_PATH),
    readJsonSafe(OUTFIELD_ODDS_PATH),
    readJsonSafe(GK_ODDS_PATH)
  ]);

  if (squads.length === 0) {
    console.error('❌ Error: squads.json is empty or not found.');
    process.exit(1);
  }

  const outputByFantasyTeam = [];

  for (const team of squads) {
    const teamName = team.squadra;
    const players = Array.isArray(team.giocatori) ? team.giocatori : [];
    const enrichedPlayers = [];

    for (const player of players) {
      const role = (player.ruolo || 'C').toUpperCase();
      const isGoalkeeper = role === 'P';
      const roleProfile = ROLE_PROFILES[role] || ROLE_PROFILES.C;

      // 1. Probabilità titolarità tramite matching protetto (ID -> Exact -> Protected Fuzzy)
      const lineupMatch = findPlayerMatch(player, lineupsData);
      let startProb = lineupMatch
        ? (lineupMatch.probabilita_titolare ?? DEFAULT_STARTER_PROB) / 100
        : DEFAULT_STARTER_PROB / 100;
      const lineupStatus = lineupMatch ? lineupMatch.status : 'bench';

      // 2. Calcolo moltiplicatori realistici di minutaggio e subentro (Punto 2.2)
      const {
        bonusMinutesMultiplier,
        penaltyMinutesMultiplier,
        baseAvailabilityFactor
      } = computeRealisticPlayingWeights(startProb, lineupStatus, roleProfile);

      let expectedBaseRating = BASE_RATING;
      let expectedBonus = 0;
      let expectedPenalty = 0;
      let expectedFantasyRating = 0;
      let details = {};

      if (isGoalkeeper) {
        // --- PORTIERE ---
        const gkOdds = findPlayerMatch(player, gkData);

        const cleanSheetProb = gkOdds
          ? (gkOdds.prob_0_gol_subiti ?? roleProfile.defaultCleanSheetProb) / 100
          : roleProfile.defaultCleanSheetProb / 100;
        const expectedGoalsConceded =
          gkOdds && gkOdds.malus_gol_atteso !== null && gkOdds.malus_gol_atteso !== undefined
            ? gkOdds.malus_gol_atteso
            : roleProfile.defaultGoalsConceded;

        // I portieri non subentrano: usano direttamente la probabilità di titolarità secca (startProb)
        // se startProb è > 0, giocano al 100% dei minuti, altrimenti 0.
        const gkMinutesWeight = startProb > 0 ? 1.0 : 0.0;

        // Bonus rigore parato (valore atteso stimato: es. 5% di probabilità di parare un rigore -> +3.0 * 0.05 = +0.15 atteso)
        const penaltySavedProb = 0.05; // 5% di incidenza media per i portieri di Serie A
        const penaltySavedBonus = penaltySavedProb * 3.0;
        const penaltySavedRatingBoost = penaltySavedProb * 0.5; // Piccolo boost al voto pagella se para un rigore

        // Voto base portiere (inclusi clean sheet, gol subiti e bonus rigore parato)
        expectedBaseRating =
          BASE_RATING +
          cleanSheetProb * GK_CS_RATING_BOOST -
          expectedGoalsConceded * GK_CONCEDED_RATING_MALUS +
          penaltySavedRatingBoost;

        expectedBonus = (cleanSheetProb * CLEAN_SHEET_BONUS + penaltySavedBonus) * gkMinutesWeight;

        const pYellow = roleProfile.defaultYellowProb / 100;
        const pRed = roleProfile.defaultRedProb / 100;
        const pOwnGoal = roleProfile.ownGoalProb / 100;

        expectedPenalty =
          (expectedGoalsConceded * GOAL_CONCEDED_MALUS +
            pYellow * YELLOW_CARD_MALUS +
            pRed * RED_CARD_MALUS +
            pOwnGoal * OWN_GOAL_MALUS) *
          gkMinutesWeight;

        details = {
          clean_sheet_probability: Math.round(cleanSheetProb * 100),
          expected_goals_conceded: Number(expectedGoalsConceded.toFixed(2)),
          penalty_saved_probability: Math.round(penaltySavedProb * 100),
          own_goal_probability: roleProfile.ownGoalProb,
          opponent: gkOdds ? gkOdds.avversario : null,
          is_home: gkOdds ? gkOdds.in_casa : null,
          has_bookmaker_odds: Boolean(gkOdds)
        };

        // Per il portiere l'Expected Fantasy Rating dipende unicamente dal fatto che giochi o meno (startProb)
        expectedFantasyRating = (expectedBaseRating + expectedBonus - expectedPenalty) * startProb;

      } else {
        // --- GIOCATORE DI MOVIMENTO (D, C, A) ---
        const odds = findPlayerMatch(player, outfieldData);

        // Se quotato usa le quote reali, altrimenti applica i fallback specifici del RUOLO (Punto 2.1)
        const rawGoalProb =
          odds && odds.probabilita_gol !== null
            ? odds.probabilita_gol / 100
            : roleProfile.defaultGoalProb / 100;
        const rawBraceProb =
          odds && odds.probabilita_doppietta !== null
            ? odds.probabilita_doppietta / 100
            : roleProfile.defaultBraceProb / 100;
        const rawAssistProb =
          odds && odds.probabilita_assist !== null
            ? odds.probabilita_assist / 100
            : roleProfile.defaultAssistProb / 100;
        const rawYellowProb =
          odds && odds.probabilita_giallo !== null
            ? odds.probabilita_giallo / 100
            : roleProfile.defaultYellowProb / 100;
        const rawRedProb =
          odds && odds.probabilita_rosso !== null
            ? odds.probabilita_rosso / 100
            : roleProfile.defaultRedProb / 100;
        const rawOwnGoalProb = roleProfile.ownGoalProb / 100;

        // Bilanciamento con la proiezione di minutaggio/subentro e con il moltiplicatore di ruolo (Punto 2.1 & 2.2)
        const effGoalProb = rawGoalProb * bonusMinutesMultiplier;
        const effBraceProb = rawBraceProb * bonusMinutesMultiplier;
        const effAssistProb = rawAssistProb * bonusMinutesMultiplier;
        const effYellowProb = Math.min(0.65, rawYellowProb * roleProfile.cardRiskMultiplier * penaltyMinutesMultiplier);
        const effRedProb = Math.min(0.15, rawRedProb * roleProfile.cardRiskMultiplier * penaltyMinutesMultiplier);
        const effOwnGoalProb = rawOwnGoalProb * penaltyMinutesMultiplier;

        // Voto puro di pagella influenzato dai bonus/malus attesi
        expectedBaseRating =
          BASE_RATING +
          effGoalProb * GOAL_RATING_BOOST +
          effAssistProb * ASSIST_RATING_BOOST -
          effYellowProb * YELLOW_RATING_MALUS -
          effRedProb * RED_RATING_MALUS;

        expectedBonus =
          effGoalProb * GOAL_BONUS +
          effBraceProb * BRACE_BONUS +
          effAssistProb * ASSIST_BONUS;

        expectedPenalty =
          effYellowProb * YELLOW_CARD_MALUS +
          effRedProb * RED_CARD_MALUS +
          effOwnGoalProb * OWN_GOAL_MALUS;

        details = {
          goal_probability: Math.round(effGoalProb * 100),
          brace_probability: Math.round(effBraceProb * 100),
          assist_probability: Math.round(effAssistProb * 100),
          yellow_card_probability: Math.round(effYellowProb * 100),
          red_card_probability: Math.round(effRedProb * 100),
          own_goal_probability: Number((effOwnGoalProb * 100).toFixed(1)),
          has_bookmaker_odds: Boolean(odds)
        };
      }

      // Calcolo finale xFM: il voto base (6.0) non crolla per i subentranti, mentre bonus e malus sono già pesati sui minuti
      expectedFantasyRating =
        expectedBaseRating * baseAvailabilityFactor + expectedBonus - expectedPenalty;

      enrichedPlayers.push({
        id: player.id,
        name: player.nome,
        role,
        real_team: player.squadraSerieA,
        starter_probability: Math.round(startProb * 100),
        lineup_status: lineupStatus,
        expected_base_rating: Number(expectedBaseRating.toFixed(2)),
        expected_bonus: Number(expectedBonus.toFixed(2)),
        expected_penalty: Number(expectedPenalty.toFixed(2)),
        expected_fantasy_rating: Number(expectedFantasyRating.toFixed(2)),
        metrics: details
      });
    }

    // Ordina l'intera rosa dal valore xFM più alto al più basso
    enrichedPlayers.sort((a, b) => b.expected_fantasy_rating - a.expected_fantasy_rating);

    // 2.3. Ottimizzatore Miglior Modulo (testa 3-4-3, 3-5-2, 4-3-3, 4-4-2, 4-5-1, 5-3-2, 5-4-1)
    const opt = optimizeTeamFormation(enrichedPlayers);

    outputByFantasyTeam.push({
      fantasy_team: teamName,
      formation: opt.bestFormation,
      defense_modifier_bonus: opt.bestModifierBonus,
      projected_top11_score: opt.bestScore,
      total_players: enrichedPlayers.length,
      starting_eleven: opt.bestLineup.map((p) => p.name),
      formations_comparison: opt.allFormations,
      roster: enrichedPlayers
    });
  }

  // Ordina le fantasquadre per punteggio proiettato del loro miglior modulo
  outputByFantasyTeam.sort((a, b) => b.projected_top11_score - a.projected_top11_score);

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(outputByFantasyTeam, null, 2), 'utf-8');

  console.log(`\n✅ Success! Generated expected fanta metrics for ${outputByFantasyTeam.length} teams.`);
  for (const t of outputByFantasyTeam) {
    console.log(
      `   🏆 ${t.fantasy_team.padEnd(20)} | Miglior modulo: ${t.formation} | Score atteso: ${t.projected_top11_score} pt (Mod. difesa: +${t.defense_modifier_bonus})`
    );
  }
  console.log(`📁 File written to: ${OUTPUT_PATH}`);
}

main();