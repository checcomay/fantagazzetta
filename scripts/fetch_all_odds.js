import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
import stringSimilarity from 'string-similarity';

import { PlayerMatcher, normalizeTeamName } from './utils/player_matcher.js';

// Configurazione variabili d'ambiente (.env) e risoluzione percorsi
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== CONFIGURAZIONE ====================
const API_KEY = process.env.ODDS_API_KEY;
const SPORT_KEY = 'soccer_italy_serie_a';
const BASE_URL = 'https://api.the-odds-api.com/v4';

// Usiamo una sola regione ('us') per evitare di moltiplicare il costo dei crediti per ogni mercato richiesto
const REGIONS = 'us';
const ODDS_FORMAT = 'decimal';

// Lista dei mercati per i giocatori di movimento (Player Props)
const PLAYER_MARKETS = [
  'player_goal_scorer_anytime', // Gol nei 90 minuti (almeno 1 gol)
  'player_goals',               // Linee Over/Under gol giocatore (usato per Over 1.5 = Doppietta e Over 0.5 = Gol)
  'player_assists',             // Assist giocatore (Yes oppure Over 0.5)
  'player_to_receive_card'      // Cartellino giocatore (Ammonizione / Giallo)
  // 'player_to_receive_red_card' // Opzionale: decommenta per estrarre anche i cartellini rossi (+1 credito/match)
];

// Mercato per i gol totali segnati dalla singola squadra (usato per calcolare i gol subiti dai portieri)
const GK_MARKET = 'team_totals';

// Uniamo tutti i mercati per effettuare un'UNICA chiamata HTTP per ciascuna partita
const ALL_MARKETS = [...PLAYER_MARKETS, GK_MARKET];

// Soglia di confidenza per il matching dei nomi delle squadre di Serie A (Portieri)
const SIMILARITY_THRESHOLD = 0.6;

// Finestra temporale: scarica solo le partite dei prossimi 4 giorni (evita di sprecare crediti sul turno successivo)
const DAYS_AHEAD = 4;

// Percorsi di input (squads.json) e di output (daily_odds.json e daily_gk_odds.json)
const SQUADS_PATH = path.resolve(__dirname, '../src/data/squads.json');
const OUTPUT_PLAYERS_PATH = path.resolve(__dirname, '../src/data/daily_odds.json');
const OUTPUT_GK_PATH = path.resolve(__dirname, '../src/data/daily_gk_odds.json');
const BETTING_WINDOW = path.resolve(__dirname, '../src/data/betting_window.json');

// ==================== FUNZIONI DI UTILITÀ ====================

/**
 * Incrocia il nome della squadra di Serie A presente in squads.json (es. "Inter")
 * con i nomi delle squadre restituiti da The Odds API (es. "Internazionale" o "Inter Milan").
 */
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

/**
 * Dato un array di quote (raccolte da più bookmaker per lo stesso giocatore e mercato),
 * calcola la quota media arrotondata a 2 decimali e la relativa probabilità implicita in percentuale.
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

/**
 * Pausa asincrona (in ms) per rispettare il rate-limit di The Odds API (max 30 richieste/secondo)
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calcola la finestra di blocco a partire dall'array di match restituito da The Odds API
 * @param {Array} apiMatches - Array di eventi restituito da The Odds API
 */
function saveBettingWindow(apiMatches) {
  if (!apiMatches || apiMatches.length === 0) 
    return;

  const nowMs = Date.now();

  // 1. Estrai tutti i timestamp (in ms) e ordinali dal più vicino al più lontano
  const allTimes = apiMatches
    .map((m) => new Date(m.commence_time).getTime())
    .filter((t) => !isNaN(t) && t > nowMs)
    .sort((a, b) => a - b);

  if (allTimes.length === 0) 
    return;

  // 2. Filtra solo le partite della GIORNATA CORRENTE.
  // The Odds API spesso mostra in anticipo anche le partite della settimana successiva:
  // teniamo solo i match che iniziano entro 5 giorni dal primo anticipo della giornata.
  const firstKickoffMs = allTimes[0];
  const MAX_ROUND_SPAN_MS = 5 * 24 * 60 * 60 * 1000; // 5 giorni
  const currentRoundTimes = allTimes.filter(
    (t) => t - firstKickoffMs <= MAX_ROUND_SPAN_MS
  );

  const lastKickoffMs = currentRoundTimes[currentRoundTimes.length - 1];

  // 3. Definisci i margini di sicurezza:
  // * LOCK START: 15 minuti prima del fischio d'inizio della prima partita
  // * LOCK END: molto dopo la fine dell'ultima partita (1 mese), il motivo è che deve
  // essere un nuovo aggiornamento delle quote ad aprire nuovamente il mercato delle quote
  const lockStartMs = firstKickoffMs - 15 * 60 * 1000;
  const lockEndMs = lastKickoffMs + 30 * 24 * 60 * 60 * 1000; // 30 giorni

  const windowData = {
    updated_at: new Date().toISOString(),
    matches_count: currentRoundTimes.length,
    first_kickoff: new Date(firstKickoffMs).toISOString(),
    last_kickoff: new Date(lastKickoffMs).toISOString(),
    lock_start: new Date(lockStartMs).toISOString(),
    lock_end: new Date(lockEndMs).toISOString()
  };

  fs.writeFile(BETTING_WINDOW, JSON.stringify(windowData, null, 2), 'utf-8');
  console.log(`🔒 Finestra quote salvata in ${BETTING_WINDOW}`);
  console.log(`   Chiusura: ${windowData.lock_start}`);
  console.log(`   Riapertura: ${windowData.lock_end}`);
}

// ==================== LOGICA DI PARSING MERCATI GIOCATORI & PORTIERI ====================

/**
 * Analizza un singolo esito (outcome) di un bookmaker e lo classifica nella categoria corretta:
 * 'gol' | 'doppietta' | 'assist' | 'giallo' | 'rosso' | null
 */
function classifyOutcome(marketKey, outcome) {
  const name = outcome.name;   // Es. "Yes", "No", "Over", "Under"
  const point = outcome.point; // Es. 0.5, 1.5

  // Ignoriamo sempre le quote relative agli esiti negativi ("No" o "Under")
  if (name === 'No' || name === 'Under') return null;

  switch (marketKey) {
    case 'player_goal_scorer_anytime':
      return 'gol';

    case 'player_goals':
      // Over 0.5 corrisponde a segnare almeno 1 gol
      if (name === 'Over' && point === 0.5) return 'gol';
      // Over 1.5 corrisponde a segnare almeno 2 gol (Doppietta o più)
      if (name === 'Over' && point === 1.5) return 'doppietta';
      return null;

    case 'player_assists':
      // Accettiamo sia il formato "Yes" sia il formato "Over 0.5"
      if (name === 'Yes' || (name === 'Over' && (point === 0.5 || point === undefined))) {
        return 'assist';
      }
      return null;

    case 'player_to_receive_card':
      // Ammonizione / Cartellino giallo
      if (name === 'Yes' || (name === 'Over' && (point === 0.5 || point === undefined)) || !point) {
        return 'giallo';
      }
      return null;

    case 'player_to_receive_red_card':
      // Espulsione / Cartellino rosso
      if (name === 'Yes' || (name === 'Over' && (point === 0.5 || point === undefined)) || !point) {
        return 'rosso';
      }
      return null;

    default:
      return null;
  }
}

/**
 * Calcola le probabilità che una squadra subisca 0, 1, 2 o 3+ gol.
 * Poiché i gol subiti dalla Squadra A equivalgono ai gol segnati dalla Squadra B (avversaria),
 * analizza le linee Over/Under (0.5, 1.5, 2.5) del mercato 'team_totals' dell'avversaria.
 */
function computeConcededProbabilities(opponentTeamName, bookmakers) {
  const lines = {
    '0.5': { over: [], under: [] },
    '1.5': { over: [], under: [] },
    '2.5': { over: [], under: [] }
  };

  const normTarget = normalizeTeamName(opponentTeamName);

  // Raccoglie tutte le quote Over/Under per le soglie 0.5, 1.5 e 2.5 della squadra avversaria
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

  // Funzione interna per normalizzare le probabilità Over/Under rimuovendo il margine (overround) del bookmaker
  const getLineProb = (point) => {
    const overs = lines[point].over;
    const unders = lines[point].under;

    if (overs.length === 0 && unders.length === 0) return null;

    const pOverRaw = overs.length > 0 ? 1 / (overs.reduce((a, b) => a + b, 0) / overs.length) : null;
    const pUnderRaw = unders.length > 0 ? 1 / (unders.reduce((a, b) => a + b, 0) / unders.length) : null;

    // Se abbiamo sia Over che Under, normalizziamo la somma al 100%
    if (pOverRaw !== null && pUnderRaw !== null) {
      const total = pOverRaw + pUnderRaw;
      return {
        over: (pOverRaw / total) * 100,
        under: (pUnderRaw / total) * 100
      };
    }

    // Fallback se il bookmaker espone solo uno dei due lati
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

  // Se non esistono né la linea 0.5 né la 1.5, i dati sono insufficienti
  if (!p05 && !p15) return null;

  // Stime di continuità qualora una delle tre linee non sia quotata
  const probOver05 = p05 ? p05.over : p15 ? Math.min(95, p15.over + 25) : 75;
  const probOver15 = p15 ? p15.over : p05 ? Math.max(5, p05.over - 25) : 40;
  const probOver25 = p25 ? p25.over : Math.max(3, probOver15 - 20);

  // Calcolo delle probabilità discrete per singolo scaglione di gol subiti
  return {
    prob_0_gol_subiti: Math.round(100 - probOver05),                      // Clean Sheet (Under 0.5 avversario)
    prob_1_gol_subito: Math.round(Math.max(0, probOver05 - probOver15)),  // Esattamente 1 gol subito
    prob_2_gol_subiti: Math.round(Math.max(0, probOver15 - probOver25)),  // Esattamente 2 gol subiti
    prob_3_piu_gol_subiti: Math.round(probOver25)                         // 3 o più gol subiti (Over 2.5 avversario)
  };
}

// ==================== CHIAMATE HTTP (AXIOS) ====================

/**
 * Recupera la lista delle partite di Serie A in programma nei prossimi DAYS_AHEAD giorni.
 * NOTA: Questo endpoint è gratuito e consuma 0 crediti API.
 */
async function fetchUpcomingEvents() {
  const now = new Date();
  const futureDate = new Date(now.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);

  // Formato ISO 8601 richiesto da The Odds API (senza millisecondi)
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
 * Esegue una singola chiamata HTTP per partita chiedendo sia i Player Props sia i Team Totals.
 * Restituisce i dati e gli header con il conteggio dei crediti API spesi e residui.
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

/**
 * Gestisce e formatta in console gli errori restituiti da Axios o da The Odds API.
 */
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

  // 1. INIZIALIZZAZIONE PLAYER MATCHER E CARICAMENTO PORTIERI DA SQUADS.JSON
  // Inizializza PlayerMatcher per i giocatori di movimento (includeGoalkeepers: false)
  // caricando internamente sia squads.json che alias_map.json
  const matcher = new PlayerMatcher({ includeGoalkeepers: false });
  let squads = [];

  try {
    await matcher.init(SQUADS_PATH);
    const squadsRaw = await fs.readFile(SQUADS_PATH, 'utf-8');
    squads = JSON.parse(squadsRaw);
  } catch (err) {
    console.error(`❌ Errore durante il caricamento dei file locali: ${err.message}`);
    process.exit(1);
  }

  const allRawApiNames = new Set();

  // Estraiamo la lista dei portieri (ruolo === 'P') da squads.json
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

  console.log(
    `📂 Caricati ${matcher.playersByNormName.size} giocatori di movimento (in PlayerMatcher) e ${goalkeepers.length} portieri.`
  );

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
    console.log('ℹ️ Nessuna partita in programma nella finestra temporale. Uscita.');
    return;
  }

  // Salva in locale la finestra temporale in cui verranno giocate le partite
  saveBettingWindow(events);

  // Mappe di accumulo per le quote dei giocatori e le statistiche difensive delle squadre
  const matchedPlayersQuotes = new Map();
  const teamDefenseStats = new Map();

  // 3. CICLO SULLE PARTITE: CHIAMATA UNICA PER EVENTO (Player Props + Team Totals)
  for (const event of events) {
    const homeTeam = event.home_team;
    const awayTeam = event.away_team;
    const matchTitle = `${homeTeam} vs ${awayTeam}`;
    console.log(`\n🔍 Analisi match: ${matchTitle} (ID: ${event.id})...`);

    try {
      const { data: eventOdds, quotaInfo } = await fetchUnifiedEventOdds(event.id);
      console.log(
        `   📊 Costo chiamata unificata: ${quotaInfo.lastCost} crediti | Crediti residui: ${quotaInfo.remaining}`
      );

      const bookmakers = eventOdds.bookmakers || [];
      if (bookmakers.length === 0) {
        console.log(`   ⚠️ Nessuna quota ancora disponibile per questa partita.`);
        continue;
      }

      // A) Calcolo probabilità gol subiti per i Portieri (tramite mercato team_totals)
      // I gol subiti dalla squadra di casa dipendono dai gol segnati dalla squadra ospite (awayTeam)
      const homeDefense = computeConcededProbabilities(awayTeam, bookmakers);
      if (homeDefense) {
        teamDefenseStats.set(normalizeTeamName(homeTeam), {
          squadra: homeTeam,
          avversario: awayTeam,
          in_casa: true,
          ...homeDefense
        });
      }

      // I gol subiti dalla squadra ospite dipendono dai gol segnati dalla squadra di casa (homeTeam)
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
          if (marketKey === GK_MARKET) continue; // Il mercato team_totals è già stato elaborato al punto A

          for (const outcome of marketObj.outcomes || []) {
            const category = classifyOutcome(marketKey, outcome);
            if (!category) continue;

            // Su The Odds API il nome del giocatore è in 'description' (o in 'name' per alcuni bookmaker)
            const apiPlayerName = outcome.description || outcome.name;
            const oddPrice = parseFloat(outcome.price);

            // Salva sul set in locale per log
            allRawApiNames.add(`${apiPlayerName} [${matchTitle}]`);

            if (!apiPlayerName || isNaN(oddPrice) || oddPrice <= 1.0) continue;

            // Eseguiamo il matching con la pipeline a cascata (alias_map -> exact -> fuzzy)
            // passando le due squadre del match per evitare falsi positivi con giocatori di altre partite
            const match = matcher.match(apiPlayerName, {
              allowedTeams: [homeTeam, awayTeam],
              context: matchTitle
            });

            if (match) {
              const localPlayer = match.player;
              if (!matchedPlayersQuotes.has(localPlayer.nome)) {
                matchedPlayersQuotes.set(localPlayer.nome, {
                  id: localPlayer.id,
                  nome: localPlayer.nome,
                  ruolo: localPlayer.ruolo,
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
              // Aggiunge la quota alla categoria corrispondente per poi fare la media tra bookmaker
              matchedPlayersQuotes.get(localPlayer.nome).quotes[category].push(oddPrice);
            }
          }
        }
      }

      // Pausa di 250ms tra un match e l'altro per non saturare il rate limit
      await sleep(250);
    } catch (error) {
      handleApiError(error, `Recupero quote per ${matchTitle}`);
      // Se i crediti API sono terminati (HTTP 401), interrompiamo il ciclo ma salviamo i dati già raccolti
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
      id: playerData.id,
      nome: playerData.nome,
      ruolo: playerData.ruolo,
      squadra_fanta: playerData.squadra_fanta,
      squadra_reale: playerData.squadra_reale,
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

  // Ordiniamo i giocatori di movimento per probabilità di gol decrescente (e a parità, per assist)
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
      // Media pesata dei gol subiti attesi (equivale al malus atteso di -1 per gol subito)
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

  // Ordiniamo i portieri per probabilità di imbattibilità (Clean Sheet) decrescente
  finalGkOutput.sort((a, b) => (b.prob_0_gol_subiti || 0) - (a.prob_0_gol_subiti || 0));

  // 6. SALVATAGGIO DI ENTRAMBI I FILE JSON SU DISCO
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

  // 7. STAMPA DEL REPORT DI TELEMETRIA (Matched, Unmatched, Flagged a bassa confidenza)
  matcher.printTelemetryReport('The Odds API - Serie A Unificato');

  // Salva il dump completo di tutti i nomi unici restituiti dall'API per la giornata
  const dumpPath = path.resolve(__dirname, '../src/data/raw_api_players_dump.json');
  await fs.writeFile(dumpPath, JSON.stringify(Array.from(allRawApiNames).sort(), null, 2), 'utf-8');
  console.log(`📋 Dump grezzo di ${allRawApiNames.size} nomi API salvato in: ${dumpPath}`);
}

main();