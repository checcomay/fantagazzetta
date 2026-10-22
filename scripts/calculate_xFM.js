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

// ==================== VALUE CONFIGURATION ====================
const DEFENSE_MODIFIER_BONUS = 1.5;         // bonus difesa medio
const X_GOALS_CONCEDED = 1.35;              // media standard gol subiti in Serie A se non quotato

const CLEAN_SHEET_BONUS = 1.0;
const GOAL_CONCEDED_MALUS = 1.0;

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
    if (lastNameMatch.bestMatch.rating > bestScore && lastNameMatch.bestMatch.rating >= 0.85) {
      bestScore = lastNameMatch.bestMatch.rating;
      bestKey = lastNameMatch.bestMatch.target;
    }
  }

  if (bestScore >= 0.6) {
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
      const startProb = lineupMatch ? (lineupMatch.probabilita_titolare || 5) / 100 : 0.05;
      const lineupStatus = lineupMatch ? lineupMatch.status : 'bench';

      let expectedBaseRating = 6.0;
      let expectedBonus = 0;
      let expectedPenalty = 0;
      let details = {};

      if (isGoalkeeper) {
        // --- PORTIERE ---
        const gkOdds = findBestMatch(player.nome, gkMap);

        const cleanSheetProb = gkOdds ? (gkOdds.prob_0_gol_subiti || 25) / 100 : 0.25;
        const expectedGoalsConceded = gkOdds && gkOdds.malus_gol_atteso !== null
          ? gkOdds.malus_gol_atteso
          : X_GOALS_CONCEDED; // media standard gol subiti in Serie A se non quotato

        // Il voto base del portiere aumenta con l'imbattibilità e scende se incassa molti gol
        expectedBaseRating = 6.0 + (cleanSheetProb * 0.25) - (expectedGoalsConceded * 0.15);

        // Bonus imbattibilità = +1 | Malus gol subito = -1 per gol
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

        const pGoal = odds ? (odds.probabilita_gol || 5) / 100 : 0.05;
        const pBrace = odds ? (odds.probabilita_doppietta || 1) / 100 : 0.01;
        const pAssist = odds ? (odds.probabilita_assist || 6) / 100 : 0.06;
        const pYellow = odds ? (odds.probabilita_giallo || 15) / 100 : 0.15;
        const pRed = odds ? (odds.probabilita_rosso || 1) / 100 : 0.01;
        const pOwnGoal = 0.01; // Probabilità storica empirica media

        // Correzione voto pagella influenzato da bonus/malus
        expectedBaseRating = 6.0 + pGoal * 0.35 + pAssist * 0.2 - pYellow * 0.25 - pRed * 0.5;

        // Bonus: Gol (+3), Doppietta (+3 addizionali), Assist (+1)
        expectedBonus = pGoal * 3.0 + pBrace * 3.0 + pAssist * 1.0;

        // Malus: Giallo (-0.5), Rosso (-1), Autogol (-2)
        expectedPenalty = pYellow * 0.5 + pRed * 1.0 + pOwnGoal * 2.0;

        details = {
          goal_probability: Math.round(pGoal * 100),
          brace_probability: Math.round(pBrace * 100),
          assist_probability: Math.round(pAssist * 100),
          yellow_card_probability: Math.round(pYellow * 100),
          red_card_probability: Math.round(pRed * 100),
          own_goal_probability: Math.round(pOwnGoal * 100)
        };
      }

      // Expected Rating a pieno minutaggio (Titolare)
      const fullMatchExpectedRating = expectedBaseRating + expectedBonus - expectedPenalty;

      // Ponderazione con la probabilità di andare a voto/titolare
      // Chi parte dalla panchina ha una chance ridotta (35%) di impatto
      const appearanceWeight = startProb + (0.35 * (1 - startProb));
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
        expected_fantasy_rating: Number(expectedFantasyRating.toFixed(2)), // Valore xFM
        metrics: details
      });
    }

    // Ordina i giocatori della rosa dal valore xFM più alto al più basso
    enrichedPlayers.sort((a, b) => b.expected_fantasy_rating - a.expected_fantasy_rating);

    // Selezione 11 titolare col modulo 4-3-3 (1 P, 4 D, 3 C, 3 A) + 1.5 Bonus Difesa
    const best11 = selectTop11With433(enrichedPlayers);
    const playersSum = best11.reduce((acc, p) => acc + p.expected_fantasy_rating, 0);
    const teamExpectedTotal = playersSum + DEFENSE_MODIFIER_BONUS;

    outputByFantasyTeam.push({
      fantasy_team: teamName,
      formation: '4-3-3',
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