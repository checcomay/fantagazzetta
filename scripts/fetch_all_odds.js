import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
import stringSimilarity from 'string-similarity';

// Configurazione variabili d'ambiente e percorsi ES6
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== CONFIGURAZIONE ====================
const API_KEY = process.env.ODDS_API_KEY;
const SPORT_KEY = 'soccer_italy_serie_a';
const BASE_URL = 'https://api.the-odds-api.com/v4';

// Usiamo una sola regione ('us') per evitare di moltiplicare x2 il costo di tutti i mercati
const REGIONS = 'us';
const ODDS_FORMAT = 'decimal';

// Mercati giocatori + mercato portieri (team_totals) in un'unica lista
const PLAYER_MARKETS = [
  'player_goal_scorer_anytime', // Gol (almeno 1)
  'player_goals',               // Usato per estrarre Over 1.5 (Doppietta / 2+ gol) e Over 0.5
  'player_assists',             // Assist (almeno 1 / Over 0.5)
  'player_to_receive_card'      // Cartellino (Ammonizione / Giallo)
  // 'player_to_receive_red_card' // Decommenta se vuoi spendere 1 credito/match in più per i rossi
];
const GK_MARKET = 'team_totals';
const ALL_MARKETS = [...PLAYER_MARKETS, GK_MARKET];

const SIMILARITY_THRESHOLD = 0.6;
const DAYS_AHEAD = 4;

// Percorsi file relativi alla root del progetto Astro
const SQUADS_PATH = path.resolve(__dirname, '../src/data/squads.json');
const OUTPUT_PLAYERS_PATH = path.resolve(__dirname, '../src/data/daily_odds.json');
const OUTPUT_GK_PATH = path.resolve(__dirname, '../src/data/daily_gk_odds.json');

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

// ==================== UTILITY DI NORMALIZZAZIONE & MATCHING ====================

function normalizePlayerName(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b[a-z]\./g, '')
    .replace(/[^a-z\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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

function findMatchingLocalPlayer(apiPlayerName, localPlayersMap) {
  const normApiName = normalizePlayerName(apiPlayerName);
  const localNormNames = Array.from(localPlayersMap.keys());

  if (!normApiName || localNormNames.length === 0) return null;

  // 1. Confronto sul nome completo normalizzato
  const matchResult = stringSimilarity.findBestMatch(normApiName, localNormNames);
  let bestScore = matchResult.bestMatch.rating;
  let bestTargetKey = matchResult.bestMatch.target;

  // 2. Fallback sul solo cognome (ultima parola del nome API)
  const apiNameParts = normApiName.split(' ');
  if (apiNameParts.length > 1) {
    const apiLastName = apiNameParts[apiNameParts.length - 1];
    const lastNameMatch = stringSimilarity.findBestMatch(apiLastName, localNormNames);

    if (lastNameMatch.bestMatch.rating > bestScore && lastNameMatch.bestMatch.rating >= 0.85) {
      bestScore = lastNameMatch.bestMatch.rating;
      bestTargetKey = lastNameMatch.bestMatch.target;
    }
  }

  if (bestScore >= SIMILARITY_THRESHOLD) {
    return {
      player: localPlayersMap.get(bestTargetKey),
      score: bestScore
    };
  }

  return null;
}

function matchTeam(localTeamName, apiTeamNames) {
  if (!localTeamName || apiTeamNames.length === 0) return null;
  const normLocal = normalizeTeamName(localTeamName);
  const match = stringSimilarity.findBestMatch(
    normLocal,
    apiTeamNames.map((t) => normalizeTeamName(t))
  );

  if (match.bestMatch.rating >= SIMILARITY_THRESHOLD) {
    return apiTeamNames[match.bestMatchIndex];
  }
  return null;
}

function calculateMarketStats(quotesArray) {
  if (!quotesArray || quotesArray.length === 0) {
    return { quota: null, probabilita: null };
  }
  const sum = quotesArray.reduce((acc, val) => acc + val, 0);
  const avgQuote = Number((sum / quotesArray.length).toFixed(2));
  const probability = Math.round((1 / avgQuote) * 100);

  return { quota: avgQuote, probabilita: probability };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ==================== LOGICA DI PARSING MERCATI GIOCATORI & PORTIERI ====================

function classifyOutcome(marketKey, outcome) {
  const name = outcome.name;
  const point = outcome.point;

  if (name === 'No' || name === 'Under') return null;

  switch (marketKey) {
    case 'player_goal_scorer_anytime':
      return 'gol';

    case 'player_goals':
      if (name === 'Over' && point === 0.5) return 'gol';
      if (name === 'Over' && point === 1.5) return 'doppietta';
      return null;

    case 'player_assists':
      if (name === 'Yes' || (name === 'Over' && (point === 0.5 || point === undefined))) {
        return 'assist';
      }
      return null;

    case 'player_to_receive_card':
      if (name === 'Yes' || (name === 'Over' && (point === 0.5 || point === undefined)) || !point) {
        return 'giallo';
      }
      return null;

    case 'player_to_receive_red_card':
      if (name === 'Yes' || (name === 'Over' && (point === 0.5 || point === undefined)) || !point) {
        return 'rosso';
      }
      return null;

    default:
      return null;
  }
}

function computeConcededProbabilities(opponentTeamName, bookmakers) {
  const lines = {
    '0.5': { over: [], under: [] },
    '1.5': { over: [], under: [] },
    '2.5': { over: [], under: [] }
  };

  const normTarget = normalizeTeamName(opponentTeamName);

  for (const bookie of bookmakers) {
    for (const market of bookie.markets || []) {
      if (market.key !== GK_MARKET) continue;

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

    const pOverRaw = overs.length > 0 ? 1 / (overs.reduce((a, b) => a + b, 0) / overs.length) : null;
    const pUnderRaw = unders.length > 0 ? 1 / (unders.reduce((a, b) => a + b, 0) / unders.length) : null;

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

  const probOver05 = p05 ? p05.over : p15 ? Math.min(95, p15.over + 25) : 75;
  const probOver15 = p15 ? p15.over : p05 ? Math.max(5, p05.over - 25) : 40;
  const probOver25 = p25 ? p25.over : Math.max(3, probOver15 - 20);

  return {
    prob_0_gol_subiti: Math.round(100 - probOver05),
    prob_1_gol_subito: Math.round(Math.max(0, probOver05 - probOver15)),
    prob_2_gol_subiti: Math.round(Math.max(0, probOver15 - probOver25)),
    prob_3_piu_gol_subiti: Math.round(probOver25)
  };
}

// ==================== CHIAMATE HTTP (AXIOS) ====================

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

/**
 * Unica chiamata HTTP per partita: estrae contemporaneamente Player Props e Team Totals
 */
async function fetchUnifiedEventOdds(eventId) {
  const url = `${BASE_URL}/sports/${SPORT_KEY}/events/${eventId}/odds`;
  const response = await axios.get(url, {
    params: {
      apiKey: API_KEY,
      regions: REGIONS,
      markets: ALL_MARKETS.join(','),
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

function handleApiError(error, contextMessage) {
  if (error.response) {
    const status = error.response.status;
    const errorData = error.response.data;
    const apiMessage = errorData?.message || JSON.stringify(errorData);

    console.error(`\n❌ [ERRORE API - ${contextMessage}] Status HTTP: ${status}`);
    switch (status) {
      case 401:
        console.error(`🔒 API Key non valida o crediti esauriti (OUT_OF_USAGE_CREDITS). Dettagli: ${apiMessage}`);
        break;
      case 422:
        console.error(`⚠️ Parametri non validi. Dettagli: ${apiMessage}`);
        break;
      case 429:
        console.error(`⏳ Rate limit superato (max 30 req/s). Dettagli: ${apiMessage}`);
        break;
      default:
        console.error(`Dettagli risposta: ${apiMessage}`);
    }
  } else if (error.request) {
    console.error(`\n❌ [ERRORE DI RETE - ${contextMessage}] Nessuna risposta dal server.`);
  } else {
    console.error(`\n❌ [ERRORE INTERNO - ${contextMessage}] ${error.message}`);
  }
}

// ==================== ESECUZIONE PRINCIPALE ====================

async function main() {
  console.log('🚀 Avvio estrazione UNIFICATA Serie A (Giocatori di movimento + Portieri)...');

  if (!API_KEY) {
    console.error('❌ ERRORE CRITICO: Variabile ODDS_API_KEY mancante nel file .env!');
    process.exit(1);
  }

  // 1. CARICAMENTO UNICO DI squads.json (Separa Portieri e Giocatori di movimento)
  let squads = [];
  try {
    const fileContent = await fs.readFile(SQUADS_PATH, 'utf-8');
    squads = JSON.parse(fileContent);
  } catch (err) {
    console.error(`❌ Impossibile leggere ${SQUADS_PATH}: ${err.message}`);
    process.exit(1);
  }

  const localPlayersMap = new Map();
  const goalkeepers = [];

  for (const fantaTeam of squads) {
    const teamName = fantaTeam.squadra;
    const players = Array.isArray(fantaTeam.giocatori) ? fantaTeam.giocatori : [];

    for (const player of players) {
      const role = (player.ruolo || '').toUpperCase();

      if (role === 'P') {
        goalkeepers.push({
          id: player.id,
          nome: player.nome,
          squadra_fanta: teamName,
          squadra_reale: player.squadraSerieA,
          prezzo_acquisto: player.prezzoAcquisto
        });
      } else if (player.nome) {
        localPlayersMap.set(normalizePlayerName(player.nome), {
          id: player.id,
          nome: player.nome,
          fantaSquadra: teamName,
          squadra: player.squadraSerieA,
          ruolo: player.ruolo,
          prezzoAcquisto: player.prezzoAcquisto
        });
      }
    }
  }

  console.log(`📂 Caricati ${localPlayersMap.size} giocatori di movimento e ${goalkeepers.length} portieri.`);

  // 2. RECUPERO PARTITE SERIE A (0 crediti consumati)
  let events = [];
  try {
    events = await fetchUpcomingEvents();
    console.log(`📅 Trovate ${events.length} partite nei prossimi ${DAYS_AHEAD} giorni.`);
  } catch (error) {
    handleApiError(error, 'Recupero calendario partite');
    process.exit(1);
  }

  if (events.length === 0) {
    console.log('ℹ️ Nessuna partita in programma. Uscita.');
    return;
  }

  const matchedPlayersQuotes = new Map();
  const teamDefenseStats = new Map();

  // 3. CHIAMATA UNICA PER EVENTO (Estrae sia Player Props sia Team Totals)
  for (const event of events) {
    const homeTeam = event.home_team;
    const awayTeam = event.away_team;
    const matchTitle = `${homeTeam} vs ${awayTeam}`;
    console.log(`\n🔍 Analisi match: ${matchTitle} (ID: ${event.id})...`);

    try {
      const { data: eventOdds, quotaInfo } = await fetchUnifiedEventOdds(event.id);
      console.log(`   📊 Costo chiamata unificata: ${quotaInfo.lastCost} crediti | Crediti residui: ${quotaInfo.remaining}`);

      const bookmakers = eventOdds.bookmakers || [];
      if (bookmakers.length === 0) {
        console.log(`   ⚠️ Nessuna quota ancora disponibile per questa partita.`);
        continue;
      }

      // A) Calcolo probabilità gol subiti per i Portieri (da team_totals)
      const homeDefense = computeConcededProbabilities(awayTeam, bookmakers);
      if (homeDefense) {
        teamDefenseStats.set(normalizeTeamName(homeTeam), {
          squadra: homeTeam,
          avversario: awayTeam,
          in_casa: true,
          ...homeDefense
        });
      }

      const awayDefense = computeConcededProbabilities(homeTeam, bookmakers);
      if (awayDefense) {
        teamDefenseStats.set(normalizeTeamName(awayTeam), {
          squadra: awayTeam,
          avversario: homeTeam,
          in_casa: false,
          ...awayDefense
        });
      }

      // B) Parsing Player Props per i Giocatori di movimento
      for (const bookie of bookmakers) {
        for (const marketObj of bookie.markets || []) {
          const marketKey = marketObj.key;
          if (marketKey === GK_MARKET) continue; // Già elaborato sopra

          for (const outcome of marketObj.outcomes || []) {
            const category = classifyOutcome(marketKey, outcome);
            if (!category) continue;

            const apiPlayerName = outcome.description || outcome.name;
            const oddPrice = parseFloat(outcome.price);

            if (!apiPlayerName || isNaN(oddPrice) || oddPrice <= 1.0) continue;

            const match = findMatchingLocalPlayer(apiPlayerName, localPlayersMap);
            if (match) {
              const localPlayer = match.player;
              if (!matchedPlayersQuotes.has(localPlayer.nome)) {
                matchedPlayersQuotes.set(localPlayer.nome, {
                  nome: localPlayer.nome,
                  squadra_fanta: localPlayer.fantaSquadra,
                  squadra_reale: localPlayer.squadra || null,
                  quotes: {
                    gol: [],
                    doppietta: [],
                    assist: [],
                    giallo: [],
                    rosso: []
                  }
                });
              }
              matchedPlayersQuotes.get(localPlayer.nome).quotes[category].push(oddPrice);
            }
          }
        }
      }

      await sleep(250);
    } catch (error) {
      handleApiError(error, `Recupero quote per ${matchTitle}`);
      if (error.response?.status === 401) {
        console.warn('🛑 Crediti esauriti, salvo i dati parziali raccolti finora...');
        break;
      }
    }
  }

  // 4. COSTRUZIONE OUTPUT GIOCATORI DI MOVIMENTO (daily_odds.json)
  const finalPlayersOutput = [];
  for (const [, playerData] of matchedPlayersQuotes.entries()) {
    const golStats = calculateMarketStats(playerData.quotes.gol);
    const doppiettaStats = calculateMarketStats(playerData.quotes.doppietta);
    const assistStats = calculateMarketStats(playerData.quotes.assist);
    const gialloStats = calculateMarketStats(playerData.quotes.giallo);
    const rossoStats = calculateMarketStats(playerData.quotes.rosso);

    finalPlayersOutput.push({
      nome: playerData.nome,
      squadra_fanta: playerData.squadra_fanta,
      quota_gol: golStats.quota,
      probabilita_gol: golStats.probabilita,
      quota_doppietta: doppiettaStats.quota,
      probabilita_doppietta: doppiettaStats.probabilita,
      quota_assist: assistStats.quota,
      probabilita_assist: assistStats.probabilita,
      quota_giallo: gialloStats.quota,
      probabilita_giallo: gialloStats.probabilita,
      quota_rosso: rossoStats.quota,
      probabilita_rosso: rossoStats.probabilita
    });
  }

  finalPlayersOutput.sort((a, b) => {
    const golDiff = (b.probabilita_gol || 0) - (a.probabilita_gol || 0);
    if (golDiff !== 0) return golDiff;
    return (b.probabilita_assist || 0) - (a.probabilita_assist || 0);
  });

  // 5. COSTRUZIONE OUTPUT PORTIERI (daily_gk_odds.json)
  const knownApiTeams = Array.from(teamDefenseStats.values()).map((v) => v.squadra);
  const finalGkOutput = [];

  for (const gk of goalkeepers) {
    const matchedApiTeam = matchTeam(gk.squadra_reale, knownApiTeams);
    const defense = matchedApiTeam ? teamDefenseStats.get(normalizeTeamName(matchedApiTeam)) : null;

    finalGkOutput.push({
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

  finalGkOutput.sort((a, b) => (b.prob_0_gol_subiti || 0) - (a.prob_0_gol_subiti || 0));

  // 6. SALVATAGGIO DI ENTRAMBI I FILE JSON
  try {
    await fs.mkdir(path.dirname(OUTPUT_PLAYERS_PATH), { recursive: true });
    await Promise.all([
      fs.writeFile(OUTPUT_PLAYERS_PATH, JSON.stringify(finalPlayersOutput, null, 2), 'utf-8'),
      fs.writeFile(OUTPUT_GK_PATH, JSON.stringify(finalGkOutput, null, 2), 'utf-8')
    ]);

    console.log(`\n✅ Operazione completata con successo!`);
    console.log(`   ⚽ Salvati ${finalPlayersOutput.length} giocatori di movimento in ${OUTPUT_PLAYERS_PATH}`);
    console.log(`   🧤 Salvati ${finalGkOutput.length} portieri in ${OUTPUT_GK_PATH}`);
  } catch (err) {
    console.error(`❌ Errore nel salvataggio dei file JSON: ${err.message}`);
    process.exit(1);
  }
}

main();