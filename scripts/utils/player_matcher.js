import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import stringSimilarity from 'string-similarity';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_SQUADS_PATH = path.resolve(__dirname, '../../src/data/squads.json');
const DEFAULT_ALIAS_PATH = path.resolve(__dirname, '../../src/data/alias_map.json');

// Soglie di confidenza
const FUZZY_MIN_THRESHOLD = 0.62; // Sotto questa soglia il giocatore viene ignorato (unmatched)
const HIGH_CONFIDENCE_THRESHOLD = 0.78; // Sotto questa soglia (ma >= 0.62) viene generato un warning (flagged)

// Prefissi/suffissi irrilevanti da rimuovere durante la normalizzazione
const STOP_TOKENS = new Set(['jr', 'sr', 'ii', 'iii', 'da', 'de', 'del', 'della', 'di', 'dos', 'das', 'van', 'von', 'el', 'al']);

// Sinonimi squadre Serie A per validare il contesto partita
const SERIE_A_TEAM_ALIASES = {
  'internazionale': 'inter',
  'inter milan': 'inter',
  'ac milan': 'milan',
  'hellas verona': 'verona',
  'as roma': 'roma',
  'ss lazio': 'lazio',
  'atalanta bc': 'atalanta',
  'juventus fc': 'juventus',
  'como 1907': 'como',
  'ac monza': 'monza',
  'us lecce': 'lecce',
  'parma calcio 1913': 'parma',
  'venezia fc': 'venezia',
  'genoacfc': 'genoa',
  'cagliari calcio': 'cagliari',
  'empoli fc': 'empoli',
  'udinese calcio': 'udinese',
  'torino fc': 'torino',
  'bologna fc': 'bologna',
  'acf fiorentina': 'fiorentina',
  'ssc napoli': 'napoli'
};

/**
 * 1.2. Funzione di pulizia e normalizzazione stringhe per nomi giocatori
 */
export function normalizePlayerName(rawName) {
  if (!rawName || typeof rawName !== 'string') return '';

  const cleaned = rawName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Rimuove accenti e diacritici
    .toLowerCase()
    .replace(/\b[a-z]\.(?:\s*[a-z]\.)*/g, '') // Rimuove iniziali puntate (es. "c.", "d.s.")
    .replace(/[^a-z0-9\s-]/g, ' ') // Rimuove punteggiatura lasciando trattini (es. Fitz-Jim)
    .replace(/-/g, ' ') // Spezza i cognomi composti in token puliti
    .replace(/\s+/g, ' ')
    .trim();

  // Rimuove prefissi/suffissi non rilevanti (jr, sr, da, de, van, ecc.) e token di 1 sola lettera
  const tokens = cleaned
    .split(' ')
    .filter((token) => token.length > 1 && !STOP_TOKENS.has(token));

  return tokens.join(' ');
}

export function normalizeTeamName(teamName) {
  if (!teamName) return '';
  const clean = teamName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
  return SERIE_A_TEAM_ALIASES[clean] || clean;
}

/**
 * Classe principale per il Data Matching con Telemetria integrata
 */
export class PlayerMatcher {
  constructor({ includeGoalkeepers = true } = {}) {
    this.includeGoalkeepers = includeGoalkeepers;
    this.playersByNormName = new Map(); // normName -> playerObj
    this.playersByExactRaw = new Map(); // rawLower -> playerObj
    this.aliasMap = new Map(); // normAliasKey -> rawTargetName

    // Strutture per la Telemetria (Punto 1.3)
    this.telemetry = {
      matched: new Map(),   // apiName -> { targetName, fantaTeam, method, confidence }
      flagged: new Map(),   // apiName -> { targetName, fantaTeam, method, confidence, context }
      unmatched: new Map()  // apiName -> { context, bestCandidate, bestScore, reason }
    };
  }

  /**
   * Carica squads.json e alias_map.json in memoria
   */
  async init(squadsPath = DEFAULT_SQUADS_PATH, aliasPath = DEFAULT_ALIAS_PATH) {
    // 1. Carica squads.json
    const squadsRaw = await fs.readFile(squadsPath, 'utf-8');
    const squads = JSON.parse(squadsRaw);

    for (const fantaTeam of squads) {
      const fantaTeamName = fantaTeam.squadra;
      const roster = Array.isArray(fantaTeam.giocatori) ? fantaTeam.giocatori : [];

      for (const p of roster) {
        const role = (p.ruolo || '').toUpperCase();
        if (!this.includeGoalkeepers && role === 'P') continue;

        const playerObj = {
          id: p.id,
          nome: p.nome,
          ruolo: role,
          fantaSquadra: fantaTeamName,
          squadra: p.squadraSerieA,
          squadraNorm: normalizeTeamName(p.squadraSerieA),
          prezzoAcquisto: p.prezzoAcquisto
        };

        const normKey = normalizePlayerName(p.nome);
        if (normKey) {
          this.playersByNormName.set(normKey, playerObj);
        }
        this.playersByExactRaw.set(p.nome.toLowerCase().trim(), playerObj);
      }
    }

    // 2. Carica alias_map.json (se presente)
    try {
      const aliasRaw = await fs.readFile(aliasPath, 'utf-8');
      const parsedAliases = JSON.parse(aliasRaw);

      for (const [apiKey, targetVal] of Object.entries(parsedAliases)) {
        if (apiKey.startsWith('_')) continue; // Ignora commenti nel JSON
        this.aliasMap.set(apiKey.toLowerCase().trim(), targetVal);
        const normApiKey = normalizePlayerName(apiKey);
        if (normApiKey) {
          this.aliasMap.set(normApiKey, targetVal);
        }
      }
    } catch (err) {
      console.warn(`⚠️ [PlayerMatcher] Impossibile caricare alias_map.json (${err.message}). Proseguo senza alias espliciti.`);
    }
  }

  /**
   * Risolve il nome di un giocatore secondo la pipeline a cascata:
   * 1. Lookup in alias_map.json -> 2. Exact Match -> 3. Fuzzy Match normalizzato
   *
   * @param {string} apiPlayerName - Nome proveniente da The Odds API o Fantacalcio.it
   * @param {Object} options - { allowedTeams: ['Inter', 'Milan'], context: 'Inter vs Milan' }
   */
  match(apiPlayerName, { allowedTeams = [], context = '' } = {}) {
    if (!apiPlayerName) return null;

    const rawTrimmed = apiPlayerName.trim();
    const rawLower = rawTrimmed.toLowerCase();
    const normApi = normalizePlayerName(rawTrimmed);

    if (!normApi) return null;

    const normAllowedTeams = allowedTeams.map((t) => normalizeTeamName(t)).filter(Boolean);

    // --- STEP 1: LOOKUP DETERMINISTICO IN ALIAS_MAP.JSON ---
    const aliasTarget = this.aliasMap.get(rawLower) || this.aliasMap.get(normApi);
    if (aliasTarget) {
      if (aliasTarget === '__IGNORE__') {
        this._recordUnmatched(rawTrimmed, context, null, 0, 'Ignorato esplicitamente da alias_map');
        return null;
      }

      const targetPlayer =
        this.playersByExactRaw.get(aliasTarget.toLowerCase().trim()) ||
        this.playersByNormName.get(normalizePlayerName(aliasTarget));

      if (targetPlayer) {
        this._recordMatched(rawTrimmed, targetPlayer, 'ALIAS_MAP', 1.0);
        return { player: targetPlayer, score: 1.0, method: 'ALIAS_MAP', flagged: false };
      } else {
        // IMPORTANTE: Se è in alias_map ma non in squads.json, il giocatore è SVINCOLATO.
        // Blocchiamo il fallback sul fuzzy match per evitare falsi positivi (es. Jacobo Ramón)!
        this._recordUnmatched(rawTrimmed, context, aliasTarget, 0, 'Mappato in alias_map ma svincolato in squads.json');
        return null;
      }
    }

    // --- STEP 2: EXACT MATCH NORMALIZZATO ---
    if (this.playersByNormName.has(normApi)) {
      const exactPlayer = this.playersByNormName.get(normApi);
      if (this._isTeamCompatible(exactPlayer, normAllowedTeams)) {
        this._recordMatched(rawTrimmed, exactPlayer, 'EXACT_NORM', 1.0);
        return { player: exactPlayer, score: 1.0, method: 'EXACT_NORM', flagged: false };
      }
    }

    // Controllo Exact Match sul solo cognome (ultimo token) se ha almeno 4 lettere
    const apiTokens = normApi.split(' ');
    const apiSurname = apiTokens[apiTokens.length - 1];
    if (apiTokens.length > 1 && apiSurname.length >= 4 && this.playersByNormName.has(apiSurname)) {
      const surnamePlayer = this.playersByNormName.get(apiSurname);
      if (this._isTeamCompatible(surnamePlayer, normAllowedTeams)) {
        this._recordMatched(rawTrimmed, surnamePlayer, 'EXACT_SURNAME', 0.95);
        return { player: surnamePlayer, score: 0.95, method: 'EXACT_SURNAME', flagged: false };
      }
    }

    // --- STEP 3: FUZZY MATCH NORMALIZZATO ---
    // Filtriamo il pool di candidati alle sole squadre del match (se fornite)
    const candidateEntries = Array.from(this.playersByNormName.entries()).filter(([, playerObj]) =>
      this._isTeamCompatible(playerObj, normAllowedTeams)
    );

    if (candidateEntries.length === 0) {
      this._recordUnmatched(rawTrimmed, context, null, 0, 'Nessun candidato per le squadre del match');
      return null;
    }

    const candidateKeys = candidateEntries.map(([k]) => k);

    // 3a. Fuzzy sull'intera stringa normalizzata
    const fullMatch = stringSimilarity.findBestMatch(normApi, candidateKeys);
    let bestScore = fullMatch.bestMatch.rating;
    let bestTargetKey = fullMatch.bestMatch.target;
    let matchMethod = 'FUZZY_FULL';

    // 3b. Fuzzy sul cognome (solo se il cognome ha >= 5 caratteri e supera nettamente il full match)
    if (apiTokens.length > 1 && apiSurname.length >= 5) {
      const surnameMatch = stringSimilarity.findBestMatch(apiSurname, candidateKeys);
      if (surnameMatch.bestMatch.rating > bestScore && surnameMatch.bestMatch.rating >= 0.84) {
        bestScore = surnameMatch.bestMatch.rating;
        bestTargetKey = surnameMatch.bestMatch.target;
        matchMethod = 'FUZZY_SURNAME';
      }
    }

    const bestCandidatePlayer = this.playersByNormName.get(bestTargetKey);

    if (bestScore >= FUZZY_MIN_THRESHOLD) {
      const isLowConfidence = bestScore < HIGH_CONFIDENCE_THRESHOLD;
      this._recordMatched(rawTrimmed, bestCandidatePlayer, matchMethod, bestScore, isLowConfidence, context);

      return {
        player: bestCandidatePlayer,
        score: Number(bestScore.toFixed(2)),
        method: matchMethod,
        flagged: isLowConfidence
      };
    }

    // Sotto soglia: registriamo nei non associati indicando il candidato più vicino scartato
    this._recordUnmatched(
      rawTrimmed,
      context,
      bestCandidatePlayer ? `${bestCandidatePlayer.nome} (${bestCandidatePlayer.squadra})` : null,
      bestScore,
      'Sotto soglia di confidenza'
    );
    return null;
  }

  _isTeamCompatible(playerObj, normAllowedTeams) {
    if (!normAllowedTeams || normAllowedTeams.length === 0 || !playerObj.squadraNorm) return true;
    return normAllowedTeams.some(
      (allowed) => allowed.includes(playerObj.squadraNorm) || playerObj.squadraNorm.includes(allowed)
    );
  }

  _recordMatched(apiName, playerObj, method, confidence, isFlagged = false, context = '') {
    const entry = {
      apiName,
      targetName: playerObj.nome,
      realTeam: playerObj.squadra,
      fantaTeam: playerObj.fantaSquadra,
      method,
      confidence: Number(confidence.toFixed(2)),
      context
    };

    this.telemetry.matched.set(apiName, entry);
    if (isFlagged) {
      this.telemetry.flagged.set(apiName, entry);
    }
  }

  _recordUnmatched(apiName, context, bestCandidate, bestScore, reason) {
    // Non sovrascrive se il giocatore è già stato matchato in un controllo precedente
    if (this.telemetry.matched.has(apiName)) return;

    this.telemetry.unmatched.set(apiName, {
      apiName,
      context: context || 'N/A',
      bestCandidate: bestCandidate || 'Nessuno',
      bestScore: Number((bestScore || 0).toFixed(2)),
      reason
    });
  }

  /**
   * 1.3. Stampa il report di telemetria pre-rilascio in console
   */
  printTelemetryReport(sourceLabel = 'The Odds API') {
    const matchedCount = this.telemetry.matched.size;
    const unmatchedCount = this.telemetry.unmatched.size;
    const flaggedCount = this.telemetry.flagged.size;

    console.log('\n================================================================');
    console.log(`📡 TELEMETRIA DATA MATCHING (${sourceLabel})`);
    console.log('================================================================');
    console.log(`✅ Matched: ${matchedCount} | ❓ Unmatched (Svincolati/Ignorati): ${unmatchedCount} | ⚠️ Flagged (Bassa Confidenza): ${flaggedCount}`);
    console.log('----------------------------------------------------------------');

    if (flaggedCount > 0) {
      console.warn('\n⚠️ WARNING: MATCH A BASSA CONFIDENZA (Verifica se aggiungere in alias_map.json):');
      for (const item of this.telemetry.flagged.values()) {
        console.warn(
          `   🔸 "${item.apiName}" ➔ "${item.targetName}" [${item.realTeam} - ${item.fantaTeam}] | Confidenza: ${item.confidence} (${item.method})`
        );
      }
    } else {
      console.log('\n✨ Nessun match dubbio! Tutti gli incroci superano la soglia di alta confidenza.');
    }

    if (unmatchedCount > 0) {
      console.log('\n📋 GIOCATORI NEL FEED NON ASSOCIATI A SQUADS.JSON (Svincolati nella lega o non riconosciuti):');
      const unmatchedArray = Array.from(this.telemetry.unmatched.values());
      // Mostriamo prima quelli che avevano uno score vicino alla soglia (>= 0.45) perché più sospetti
      unmatchedArray.sort((a, b) => b.bestScore - a.bestScore);

      for (const item of unmatchedArray) {
        const candidateNote =
          item.bestScore >= 0.45
            ? ` (Più simile scartato: ${item.bestCandidate} @ ${item.bestScore})`
            : '';
        console.log(`   - "${item.apiName}" [${item.context}]${candidateNote}`);
      }
    }
    console.log('================================================================\n');
  }
}