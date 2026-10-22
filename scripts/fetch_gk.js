import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
import stringSimilarity from 'string-similarity';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== CONFIGURAZIONE ====================
const API_KEY = process.env.ODDS_API_KEY;
const SPORT_KEY = 'soccer_italy_serie_a';
const BASE_URL = 'https://api.the-odds-api.com/v4';

const REGIONS = 'eu,us';
const MARKET = 'team_totals';
const ODDS_FORMAT = 'decimal';
const DAYS_AHEAD = 4;

// Percorsi file
const SQUADS_PATH = path.resolve(__dirname, '../src/data/squads.json');
const OUTPUT_PATH = path.resolve(__dirname, '../src/data/daily_gk_odds.json');

// Mappa sinonimi per allineare i nomi delle squadre di The Odds API con 'squadraSerieA'
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

function normalizeTeamName(name) {
  if (!name) return '';
  const clean = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();

  return TEAM_ALIASES[clean] || clean;
}

function matchTeam(localTeamName, apiTeamNames) {
  const normLocal = normalizeTeamName(localTeamName);
  const match = stringSimilarity.findBestMatch(
    normLocal,
    apiTeamNames.map(t => normalizeTeamName(t))
  );

  if (match.bestMatch.rating >= 0.6) {
    return apiTeamNames[match.bestMatchIndex];
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ==================== CHIAMATE HTTP ====================

async function fetchUpcomingEvents() {
  const now = new Date();
  const futureDate = new Date(now.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);

  const commenceTimeFrom = now.toISOString().split('.')[0] + 'Z';
  const commenceTimeTo = futureDate.toISOString().split('.')[0] + 'Z';

  const response = await axios.get(`${BASE_URL}/sports/${SPORT_KEY}/events`, {
    params: {
      apiKey: API_KEY,
      commenceTimeFrom,
      commenceTimeTo
    }
  });
  return response.data;
}

async function fetchEventTeamTotals(eventId) {
  const response = await axios.get(`${BASE_URL}/sports/${SPORT_KEY}/events/${eventId}/odds`, {
    params: {
      apiKey: API_KEY,
      regions: REGIONS,
      markets: MARKET,
      oddsFormat: ODDS_FORMAT
    }
  });

  return {
    data: response.data,
    quotaInfo: {
      remaining: response.headers['x-requests-remaining'],
      used: response.headers['x-requests-used'],
      lastCost: response.headers['x-requests-last']
    }
  };
}

// ==================== CALCOLO PROBABILITÀ GOL SUBITI ====================

function computeConcededProbabilities(opponentTeamName, bookmakers) {
  const lines = {
    '0.5': { over: [], under: [] },
    '1.5': { over: [], under: [] },
    '2.5': { over: [], under: [] }
  };

  const normTarget = normalizeTeamName(opponentTeamName);

  for (const bookie of bookmakers) {
    for (const market of bookie.markets || []) {
      if (market.key !== MARKET) continue;

      for (const outcome of market.outcomes || []) {
        const outcomeDesc = outcome.description || '';
        if (normalizeTeamName(outcomeDesc) !== normTarget) continue;

        const pointStr = String(outcome.point);
        const price = parseFloat(outcome.price);

        if (!lines[pointStr] || isNaN(price) || price <= 1.0) continue;

        if (outcome.name === 'Over') {
          lines[pointStr].over.push(price);
        } else if (outcome.name === 'Under') {
          lines[pointStr].under.push(price);
        }
      }
    }
  }

  const getLineProb = (point) => {
    const overs = lines[point].over;
    const unders = lines[point].under;

    if (overs.length === 0 && unders.length === 0) return null;

    let pOverRaw = overs.length > 0 ? (1 / (overs.reduce((a, b) => a + b, 0) / overs.length)) : null;
    let pUnderRaw = unders.length > 0 ? (1 / (unders.reduce((a, b) => a + b, 0) / unders.length)) : null;

    if (pOverRaw !== null && pUnderRaw !== null) {
      const total = pOverRaw + pUnderRaw;
      return {
        over: (pOverRaw / total) * 100,
        under: (pUnderRaw / total) * 100
      };
    }

    if (pOverRaw !== null) {
      const overNorm = Math.min(95, pOverRaw * 95);
      return { over: overNorm, under: 100 - overNorm };
    }
    const underNorm = Math.min(95, pUnderRaw * 95);
    return { over: 100 - underNorm, under: underNorm };
  };

  const p05 = getLineProb('0.5');
  const p15 = getLineProb('1.5');
  const p25 = getLineProb('2.5');

  if (!p05 && !p15) return null;

  const probOver05 = p05 ? p05.over : (p15 ? Math.min(95, p15.over + 25) : 75);
  const probOver15 = p15 ? p15.over : (p05 ? Math.max(5, p05.over - 25) : 40);
  const probOver25 = p25 ? p25.over : Math.max(3, probOver15 - 20);

  return {
    prob_0_gol_subiti: Math.round(100 - probOver05),
    prob_1_gol_subito: Math.round(Math.max(0, probOver05 - probOver15)),
    prob_2_gol_subiti: Math.round(Math.max(0, probOver15 - probOver25)),
    prob_3_piu_gol_subiti: Math.round(probOver25)
  };
}

// ==================== MAIN EXECUTION ====================

async function main() {
  console.log('🧤 Estrazione quote e probabilità portieri da squads.json...');

  if (!API_KEY) {
    console.error('❌ Errore: ODDS_API_KEY non trovata nel file .env');
    process.exit(1);
  }

  // 1. Lettura ed estrazione portieri da squads.json
  let squads = [];
  try {
    const raw = await fs.readFile(SQUADS_PATH, 'utf-8');
    squads = JSON.parse(raw);
  } catch (err) {
    console.error(`❌ Errore lettura ${SQUADS_PATH}: ${err.message}`);
    process.exit(1);
  }

  const goalkeepers = [];
  for (const fantaTeam of squads) {
    const teamName = fantaTeam.squadra;
    const players = Array.isArray(fantaTeam.giocatori) ? fantaTeam.giocatori : [];

    for (const player of players) {
      if ((player.ruolo || '').toUpperCase() === 'P') {
        goalkeepers.push({
          id: player.id,
          nome: player.nome,
          squadra_fanta: teamName,
          squadra_reale: player.squadraSerieA,
          prezzo_acquisto: player.prezzoAcquisto
        });
      }
    }
  }

  console.log(`📋 Estratti ${goalkeepers.length} portieri appartenenti alle fantasquadre.`);

  // 2. Chiamata eventi di Serie A
  let events = [];
  try {
    events = await fetchUpcomingEvents();
    console.log(`📅 Partite Serie A nei prossimi ${DAYS_AHEAD} giorni: ${events.length}`);
  } catch (err) {
    console.error(`❌ Errore calendario partite: ${err.message}`);
    process.exit(1);
  }

  // 3. Estrazione quote difensive per ogni squadra
  const teamDefenseStats = new Map();

  for (const event of events) {
    const homeTeam = event.home_team;
    const awayTeam = event.away_team;
    console.log(`\n⚽ Match: ${homeTeam} vs ${awayTeam}`);

    try {
      const { data: eventOdds, quotaInfo } = await fetchEventTeamTotals(event.id);
      console.log(`   📊 Crediti spesi: ${quotaInfo.lastCost} | Residui: ${quotaInfo.remaining}`);

      const bookmakers = eventOdds.bookmakers || [];
      if (bookmakers.length === 0) {
        console.log(`   ⚠️ Mercato team_totals non ancora quotato per questo match.`);
        continue;
      }

      // Casa subisce gol in base a quanti ne segna Ospite
      const homeDefense = computeConcededProbabilities(awayTeam, bookmakers);
      if (homeDefense) {
        teamDefenseStats.set(normalizeTeamName(homeTeam), {
          squadra: homeTeam,
          avversario: awayTeam,
          in_casa: true,
          ...homeDefense
        });
      }

      // Ospite subisce gol in base a quanti ne segna Casa
      const awayDefense = computeConcededProbabilities(homeTeam, bookmakers);
      if (awayDefense) {
        teamDefenseStats.set(normalizeTeamName(awayTeam), {
          squadra: awayTeam,
          avversario: homeTeam,
          in_casa: false,
          ...awayDefense
        });
      }

      await sleep(250);
    } catch (err) {
      console.error(`   ❌ Errore match ${homeTeam} vs ${awayTeam}: ${err.message}`);
    }
  }

  // 4. Mappatura finale per ciascun portiere
  const knownApiTeams = Array.from(teamDefenseStats.values()).map(v => v.squadra);
  const outputPortieri = [];

  for (const gk of goalkeepers) {
    const matchedApiTeam = matchTeam(gk.squadra_reale, knownApiTeams);
    const defense = matchedApiTeam ? teamDefenseStats.get(normalizeTeamName(matchedApiTeam)) : null;

    outputPortieri.push({
      id: gk.id,
      nome: gk.nome,
      squadra_fanta: gk.squadra_fanta,
      squadra_reale: gk.squadra_reale,
      prezzo_acquisto: gk.prezzo_acquisto,
      avversario: defense ? defense.avversario : null,
      in_casa: defense ? defense.in_casa : null,
      prob_0_gol_subiti: defense ? defense.prob_0_gol_subiti : null,
      prob_1_gol_subito: defense ? defense.prob_1_gol_subito : null,
      prob_2_gol_subiti: defense ? defense.prob_2_gol_subiti : null,
      prob_3_piu_gol_subiti: defense ? defense.prob_3_piu_gol_subiti : null,
      malus_gol_atteso: defense
        ? Number(
            (
              (defense.prob_1_gol_subito * 1 +
                defense.prob_2_gol_subiti * 2 +
                defense.prob_3_piu_gol_subiti * 3.2) /
              100
            ).toFixed(2)
          )
        : null
    });
  }

  // Ordina per miglior Clean Sheet (prob_0_gol_subiti decrescente)
  outputPortieri.sort((a, b) => (b.prob_0_gol_subiti || 0) - (a.prob_0_gol_subiti || 0));

  // 5. Scrittura file di destinazione
  try {
    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(outputPortieri, null, 2), 'utf-8');
    console.log(`\n✅ Salvataggio completato: ${outputPortieri.length} portieri scritti in ${OUTPUT_PATH}`);
  } catch (err) {
    console.error(`❌ Errore scrittura file: ${err.message}`);
    process.exit(1);
  }
}

main();