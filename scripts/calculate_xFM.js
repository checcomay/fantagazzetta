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

// ==================== VALUE & MODEL CONFIGURATION ====================

// Bonus e Malus Regolamento Fantacalcio
const GOAL_BONUS = 3.0;                     // +3 per ogni gol segnato
const BRACE_BONUS = 3.0;                    // +3 addizionali per la doppietta
const ASSIST_BONUS = 1.0;                   // +1 per ogni assist
const CLEAN_SHEET_BONUS = 1.0;              // +1 imbattibilità portiere
const GOAL_CONCEDED_MALUS = 1.0;            // -1 per ogni gol subito dal portiere
const YELLOW_CARD_MALUS = 0.5;              // -0.5 ammonizione
const RED_CARD_MALUS = 1.0;                 // -1.0 espulsione
const OWN_GOAL_MALUS = 2.0;                 // -2.0 autogol
const DEFENSE_MODIFIER_BONUS = 1.5;         // +1.5 bonus medio modificatore difesa (4-3-3)

// Voto Base e Oscillazione Pagella (impatto di bonus/malus sul voto puro)
const BASE_RATING = 6.0;                    // Voto di partenza standard
const GK_CS_RATING_BOOST = 0.25;            // Aumento voto puro portiere in caso di clean sheet
const GK_CONCEDED_RATING_MALUS = 0.15;      // Calo voto puro portiere per gol subito
const GOAL_RATING_BOOST = 0.35;             // Aumento voto puro giocatore in caso di gol
const ASSIST_RATING_BOOST = 0.20;           // Aumento voto puro giocatore in caso di assist
const YELLOW_RATING_MALUS = 0.25;           // Calo voto puro giocatore per cartellino giallo
const RED_RATING_MALUS = 0.50;              // Calo voto puro giocatore per cartellino rosso

// 3. Gestione Titolarità e Panchina
// Peso assegnato alla quota di non-titolarità (es. 0.85 = conserva l'85% del valore se parte dalla panchina,
// evitando che la xFM venga dimezzata nei ballottaggi o per i subentranti).
const NON_STARTER_WEIGHT = 0.85;

// 4. Probabilità e Valori di Default (usati come fallback se il giocatore non è quotato)
const DEFAULT_STARTER_PROB = 5;             // % titolarità di default se non presente nelle formazioni
const DEFAULT_CLEAN_SHEET_PROB = 25;        // % imbattibilità di default
const X_GOALS_CONCEDED = 1.35;              // Media standard gol subiti in Serie A se non quotato
const DEFAULT_GOAL_PROB = 5;                // % gol di default
const DEFAULT_BRACE_PROB = 1;               // % doppietta di default
const DEFAULT_ASSIST_PROB = 6;              // % assist di default
const DEFAULT_YELLOW_PROB = 15;             // % cartellino giallo di default
const DEFAULT_RED_PROB = 1;                 // % cartellino rosso di default
const DEFAULT_OWN_GOAL_PROB = 1;            // % autogol storica empirica media

// 5. Configurazione Modulo e Fuzzy Matching
const DEFAULT_FORMATION = '4-3-3';
const MATCH_THRESHOLD = 0.60;               // Soglia minima string-similarity sul nome intero
const LAST_NAME_MATCH_THRESHOLD = 0.85;     // Soglia minima fallback sul solo cognome

// ==================== HELPER FUNCTIONS ====================

// Normalizza i nomi per un fuzzy match accurato tra i diversi dataset
function normalizeName(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b[a-z]\./g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findBestMatch(name, datasetMap) {
  const normTarget = normalizeName(name);
  const keys = Array.from(datasetMap.keys());
  if (keys.length === 0 || !normTarget) return null;

  const match = stringSimilarity.findBestMatch(normTarget, keys);
  let bestScore = match.bestMatch.rating;
  let bestKey = match.bestMatch.target;

  // Fallback sul cognome
  const parts = normTarget.split(' ');
  if (parts.length > 1) {
    const lastName = parts[parts.length - 1];
    const lastNameMatch = stringSimilarity.findBestMatch(lastName, keys);
    if (
      lastNameMatch.bestMatch.rating > bestScore &&
      lastNameMatch.bestMatch.rating >= LAST_NAME_MATCH_THRESHOLD
    ) {
      bestScore = lastNameMatch.bestMatch.rating;
      bestKey = lastNameMatch.bestMatch.target;
    }
  }

  if (bestScore >= MATCH_THRESHOLD) {
    return datasetMap.get(bestKey);
  }
  return null;
}

// Lettura tollerante: se un file opzionale non esiste, restituisce un array vuoto
async function readJsonSafe(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.warn(`⚠️ Warning: Could not read ${path.basename(filePath)}. Treating as empty.`);
    return [];
  }
}

/**
 * Seleziona la formazione titolare ideale con modulo 4-3-3:
 * 1 Portiere (P), 4 Difensori (D), 3 Centrocampisti (C), 3 Attaccanti (A)
 */
function selectTop11With433(enrichedRoster) {
  const getByRole = (role, count) =>
    enrichedRoster
      .filter((p) => (p.role || '').toUpperCase() === role)
      .sort((a, b) => b.expected_fantasy_rating - a.expected_fantasy_rating)
      .slice(0, count);

  const gk = getByRole('P', 1);
  const def = getByRole('D', 4);
  const mid = getByRole('C', 3);
  const att = getByRole('A', 3);

  return [...gk, ...def, ...mid, ...att];
}

// ==================== MAIN EXECUTION ====================

async function main() {
  console.log('📊 Calculating Expected Match Fantasy Ratings (xFM)...');

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

  // Creazione indici di ricerca
  const lineupsMap = new Map();
  for (const item of lineupsData) {
    lineupsMap.set(normalizeName(item.nome), item);
  }

  const outfieldMap = new Map();
  for (const item of outfieldData) {
    outfieldMap.set(normalizeName(item.nome), item);
  }

  const gkMap = new Map();
  for (const item of gkData) {
    gkMap.set(normalizeName(item.nome), item);
  }

  const outputByFantasyTeam = [];

  for (const team of squads) {
    const teamName = team.squadra;
    const players = Array.isArray(team.giocatori) ? team.giocatori : [];
    const enrichedPlayers = [];

    for (const player of players) {
      const isGoalkeeper = (player.ruolo || '').toUpperCase() === 'P';

      // 1. Probabilità titolarità (0 - 1)
      const lineupMatch = findBestMatch(player.nome, lineupsMap);
      const startProb = lineupMatch
        ? (lineupMatch.probabilita_titolare || DEFAULT_STARTER_PROB) / 100
        : DEFAULT_STARTER_PROB / 100;
      const lineupStatus = lineupMatch ? lineupMatch.status : 'bench';

      let expectedBaseRating = BASE_RATING;
      let expectedBonus = 0;
      let expectedPenalty = 0;
      let details = {};

      if (isGoalkeeper) {
        // --- PORTIERE ---
        const gkOdds = findBestMatch(player.nome, gkMap);

        const cleanSheetProb = gkOdds
          ? (gkOdds.prob_0_gol_subiti || DEFAULT_CLEAN_SHEET_PROB) / 100
          : DEFAULT_CLEAN_SHEET_PROB / 100;
        const expectedGoalsConceded =
          gkOdds && gkOdds.malus_gol_atteso !== null
            ? gkOdds.malus_gol_atteso
            : X_GOALS_CONCEDED;

        // Voto base del portiere modulato da imbattibilità e gol subiti attesi
        expectedBaseRating =
          BASE_RATING +
          cleanSheetProb * GK_CS_RATING_BOOST -
          expectedGoalsConceded * GK_CONCEDED_RATING_MALUS;

        expectedBonus = cleanSheetProb * CLEAN_SHEET_BONUS;
        expectedPenalty = expectedGoalsConceded * GOAL_CONCEDED_MALUS;

        details = {
          clean_sheet_probability: Math.round(cleanSheetProb * 100),
          expected_goals_conceded: Number(expectedGoalsConceded.toFixed(2)),
          opponent: gkOdds ? gkOdds.avversario : null,
          is_home: gkOdds ? gkOdds.in_casa : null
        };
      } else {
        // --- GIOCATORE DI MOVIMENTO ---
        const odds = findBestMatch(player.nome, outfieldMap);

        const pGoal = odds ? (odds.probabilita_gol || DEFAULT_GOAL_PROB) / 100 : DEFAULT_GOAL_PROB / 100;
        const pBrace = odds ? (odds.probabilita_doppietta || DEFAULT_BRACE_PROB) / 100 : DEFAULT_BRACE_PROB / 100;
        const pAssist = odds ? (odds.probabilita_assist || DEFAULT_ASSIST_PROB) / 100 : DEFAULT_ASSIST_PROB / 100;
        const pYellow = odds ? (odds.probabilita_giallo || DEFAULT_YELLOW_PROB) / 100 : DEFAULT_YELLOW_PROB / 100;
        const pRed = odds ? (odds.probabilita_rosso || DEFAULT_RED_PROB) / 100 : DEFAULT_RED_PROB / 100;
        const pOwnGoal = DEFAULT_OWN_GOAL_PROB / 100;

        // Correzione voto pagella influenzato da bonus/malus
        expectedBaseRating =
          BASE_RATING +
          pGoal * GOAL_RATING_BOOST +
          pAssist * ASSIST_RATING_BOOST -
          pYellow * YELLOW_RATING_MALUS -
          pRed * RED_RATING_MALUS;

        // Calcolo Bonus e Malus attesi tramite costanti
        expectedBonus =
          pGoal * GOAL_BONUS +
          pBrace * BRACE_BONUS +
          pAssist * ASSIST_BONUS;

        expectedPenalty =
          pYellow * YELLOW_CARD_MALUS +
          pRed * RED_CARD_MALUS +
          pOwnGoal * OWN_GOAL_MALUS;

        details = {
          goal_probability: Math.round(pGoal * 100),
          brace_probability: Math.round(pBrace * 100),
          assist_probability: Math.round(pAssist * 100),
          yellow_card_probability: Math.round(pYellow * 100),
          red_card_probability: Math.round(pRed * 100),
          own_goal_probability: Math.round(pOwnGoal * 100)
        };
      }

      // Expected Rating a pieno minutaggio
      const fullMatchExpectedRating = expectedBaseRating + expectedBonus - expectedPenalty;

      // Ponderazione morbida sulla titolarità:
      // Con NON_STARTER_WEIGHT = 0.85, anche chi parte dalla panchina non subisce un crollo innaturale della xFM
      const appearanceWeight = startProb + NON_STARTER_WEIGHT * (1 - startProb);
      const expectedFantasyRating = fullMatchExpectedRating * appearanceWeight;

      enrichedPlayers.push({
        id: player.id,
        name: player.nome,
        role: player.ruolo,
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

    // Ordina i giocatori della rosa dal valore xFM più alto al più basso
    enrichedPlayers.sort((a, b) => b.expected_fantasy_rating - a.expected_fantasy_rating);

    // Selezione 11 titolare col modulo 4-3-3 (1 P, 4 D, 3 C, 3 A) + Bonus Difesa
    const best11 = selectTop11With433(enrichedPlayers);
    const playersSum = best11.reduce((acc, p) => acc + p.expected_fantasy_rating, 0);
    const teamExpectedTotal = playersSum + DEFENSE_MODIFIER_BONUS;

    outputByFantasyTeam.push({
      fantasy_team: teamName,
      formation: DEFAULT_FORMATION,
      defense_modifier_bonus: DEFENSE_MODIFIER_BONUS,
      projected_top11_score: Number(teamExpectedTotal.toFixed(2)),
      total_players: enrichedPlayers.length,
      starting_eleven: best11.map((p) => p.name),
      roster: enrichedPlayers
    });
  }

  // Ordina le squadre in base al potenziale di punteggio del loro Top 11
  outputByFantasyTeam.sort((a, b) => b.projected_top11_score - a.projected_top11_score);

  // Salvataggio output
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(outputByFantasyTeam, null, 2), 'utf-8');

  console.log(`✅ Success! Generated expected fanta metrics for ${outputByFantasyTeam.length} teams.`);
  console.log(`📁 File written to: ${OUTPUT_PATH}`);
}

main();