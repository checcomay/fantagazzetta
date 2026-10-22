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

// Regione 'us' offre la copertura maggiore per i Player Props del calcio.
// Puoi usare 'us,eu,uk' se vuoi più bookmaker (moltiplica il costo crediti per le regioni che restituiscono dati).
const REGIONS = 'us';
const ODDS_FORMAT = 'decimal';

// Mappatura dei mercati ufficiali di The Odds API v4 per il calcio
const MARKETS_CONFIG = [
  'player_goal_scorer_anytime', // Gol (almeno 1)
  'player_goals',               // Usato per estrarre Over 1.5 (Doppietta / 2+ gol)
  'player_assists',             // Assist (almeno 1 / Over 0.5)
  'player_to_receive_card',     // Cartellino (Ammonizione / Giallo)
  'player_to_receive_red_card'  // Cartellino Rosso (Espulsione)
];

const SIMILARITY_THRESHOLD = 0.6;
const DAYS_AHEAD = 4;

// Percorsi file relativi alla root del progetto Astro
const INPUT_PATH = path.resolve(__dirname, '../src/data/squads.json');
const OUTPUT_PATH = path.resolve(__dirname, '../src/data/daily_odds.json');

// ==================== UTILITY DI NORMALIZZAZIONE & MATCHING ====================

/**
 * Normalizza i nomi rimuovendo accenti, punteggiatura e iniziali puntate (es. "L. Martinez" -> "martinez")
 */
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

/**
 * Incrocia il nome del giocatore fornito dall'API con la mappa locale usando string-similarity
 */
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

/**
 * Calcola media quota e probabilità implicita per un array di quote.
 * Restituisce { quota: null, probabilita: null } se non ci sono quote disponibili.
 */
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

// ==================== LOGICA DI PARSING DEI MERCATI ====================

/**
 * Classifica un singolo 'outcome' di The Odds API nella categoria corretta del nostro JSON:
 * 'gol' | 'doppietta' | 'assist' | 'giallo' | 'rosso' | null
 */
function classifyOutcome(marketKey, outcome) {
  const name = outcome.name; // Tipicamente "Yes", "No", "Over", "Under" (o il nome giocatore in alcuni bookie)
  const point = outcome.point; // Es. 0.5, 1.5, 2.5

  // Scartiamo subito gli esiti negativi
  if (name === 'No' || name === 'Under') return null;

  switch (marketKey) {
    case 'player_goal_scorer_anytime':
      return 'gol';

    case 'player_goals':
      // Over 0.5 equivale a segnare almeno 1 gol
      if (name === 'Over' && point === 0.5) return 'gol';
      // Over 1.5 equivale a segnare almeno 2 gol (Doppietta+)
      if (name === 'Over' && point === 1.5) return 'doppietta';
      return null;

    case 'player_assists':
      // Accettiamo sia il formato "Yes" (senza point) sia "Over 0.5" (almeno 1 assist)
      if (name === 'Yes' || (name === 'Over' && (point === 0.5 || point === undefined))) {
        return 'assist';
      }
      return null;

    case 'player_to_receive_card':
      // "Yes" o "Over 0.5" per il cartellino base (Giallo / To Be Booked)
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

// ==================== CHIAMATE HTTP (AXIOS) ====================

async function fetchUpcomingEvents() {
  const now = new Date();
  const futureDate = new Date(now.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);

  const commenceTimeFrom = now.toISOString().split('.')[0] + 'Z';
  const commenceTimeTo = futureDate.toISOString().split('.')[0] + 'Z';

  const url = `${BASE_URL}/sports/${SPORT_KEY}/events`;
  const response = await axios.get(url, {
    params: {
      apiKey: API_KEY,
      commenceTimeFrom,
      commenceTimeTo
    }
  });

  return response.data;
}

async function fetchEventPlayerProps(eventId) {
  const url = `${BASE_URL}/sports/${SPORT_KEY}/events/${eventId}/odds`;
  const response = await axios.get(url, {
    params: {
      apiKey: API_KEY,
      regions: REGIONS,
      markets: MARKETS_CONFIG.join(','), // Unica chiamata per tutti i 5 mercati!
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
        console.error(`⚠️ Parametri non validi (verifica che tutte le market keys siano supportate). Dettagli: ${apiMessage}`);
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
  console.log('🚀 Avvio estrazione completa Player Props Serie A (Gol, Doppiette, Assist, Cartellini)...');

  if (!API_KEY) {
    console.error('❌ ERRORE CRITICO: Variabile ODDS_API_KEY mancante nel file .env!');
    process.exit(1);
  }

  // 1. CARICAMENTO GIOCATORI LOCALI (Esclusi i portieri)
  let squads = [];
  try {
    const fileContent = await fs.readFile(INPUT_PATH, 'utf-8');
    squads = JSON.parse(fileContent);
  } catch (err) {
    console.error(`❌ Impossibile leggere ${INPUT_PATH}: ${err.message}`);
    process.exit(1);
  }

  const localPlayersMap = new Map();
  let totalOutfieldPlayers = 0;

  for (const fantaTeam of squads) {
    const teamName = fantaTeam.squadra;
    const players = Array.isArray(fantaTeam.giocatori) ? fantaTeam.giocatori : [];

    for (const player of players) {
      // Ignora i portieri (gestiti nello script dedicato)
      if ((player.ruolo || '').toUpperCase() === 'P') continue;

      if (player.nome) {
        localPlayersMap.set(normalizePlayerName(player.nome), {
          id: player.id,
          nome: player.nome,
          fantaSquadra: teamName,
          squadra: player.squadraSerieA,
          ruolo: player.ruolo,
          prezzoAcquisto: player.prezzoAcquisto
        });
        totalOutfieldPlayers++;
      }
    }
  }
  console.log(`📂 Caricati ${totalOutfieldPlayers} giocatori di movimento da ${INPUT_PATH}`);

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

  // Mappa di accumulo quote per giocatore
  const matchedPlayersQuotes = new Map();

  // 3. RECUPERO E PARSING QUOTE PER OGNI EVENTO
  for (const event of events) {
    const matchTitle = `${event.home_team} vs ${event.away_team}`;
    console.log(`\n🔍 Analisi match: ${matchTitle} (ID: ${event.id})...`);

    try {
      const { data: eventOdds, quotaInfo } = await fetchEventPlayerProps(event.id);
      console.log(`   📊 Costo chiamata: ${quotaInfo.lastCost} crediti | Crediti residui: ${quotaInfo.remaining}`);

      const bookmakers = eventOdds.bookmakers || [];
      if (bookmakers.length === 0) {
        console.log(`   ⚠️ Nessun Player Prop ancora disponibile per questa partita.`);
        continue;
      }

      for (const bookie of bookmakers) {
        for (const marketObj of bookie.markets || []) {
          const marketKey = marketObj.key;

          for (const outcome of marketObj.outcomes || []) {
            const category = classifyOutcome(marketKey, outcome);
            if (!category) continue;

            // Su The Odds API, nei mercati Yes/No o Over/Under il nome giocatore è in 'description'
            const apiPlayerName = outcome.description || outcome.name;
            const oddPrice = parseFloat(outcome.price);

            if (!apiPlayerName || isNaN(oddPrice) || oddPrice <= 1.0) continue;

            // 4. FUZZY MATCHING CON IL TUO DATABASE
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

              // Aggiunge la quota nell'array della categoria corrispondente
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

  // 5. CALCOLO MEDIE E PROBABILITÀ IMPLICITE
  const finalOutput = [];

  for (const [, playerData] of matchedPlayersQuotes.entries()) {
    const golStats = calculateMarketStats(playerData.quotes.gol);
    const doppiettaStats = calculateMarketStats(playerData.quotes.doppietta);
    const assistStats = calculateMarketStats(playerData.quotes.assist);
    const gialloStats = calculateMarketStats(playerData.quotes.giallo);
    const rossoStats = calculateMarketStats(playerData.quotes.rosso);

    finalOutput.push({
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

  // Ordina per probabilità di gol decrescente (e a parità/assenza, per probabilità di assist)
  finalOutput.sort((a, b) => {
    const golDiff = (b.probabilita_gol || 0) - (a.probabilita_gol || 0);
    if (golDiff !== 0) return golDiff;
    return (b.probabilita_assist || 0) - (a.probabilita_assist || 0);
  });

  // 6. SALVATAGGIO JSON
  try {
    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(finalOutput, null, 2), 'utf-8');
    console.log(`\n✅ File generato con successo! Salvati ${finalOutput.length} giocatori in ${OUTPUT_PATH}`);
  } catch (err) {
    console.error(`❌ Errore nel salvataggio del JSON: ${err.message}`);
    process.exit(1);
  }
}

main();
