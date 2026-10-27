import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import stringSimilarity from 'string-similarity';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_SQUADS_PATH = path.resolve(__dirname, '../../src/data/squads.json');
const DEFAULT_ALIAS_PATH = path.resolve(__dirname, '../../src/data/alias_map.json');

const FUZZY_MIN_THRESHOLD = 0.65;
const HIGH_CONFIDENCE_THRESHOLD = 0.78;

// Manteniamo 'di', 'de', 'da', 'del', 'van' per non trasformare "Di Lorenzo" in "lorenzo"
const STOP_TOKENS = new Set(['jr', 'sr', 'ii', 'iii', 'dos', 'das', 'do']);

// Esiti non-giocatore inviati dai bookmaker da ignorare
const NON_PLAYER_OUTCOMES = new Set(['no scorer', 'no goalscorer', 'own goal', 'any other player', 'none']);

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

export function normalizePlayerName(rawName, keepInitials = false) {
  if (!rawName || typeof rawName !== 'string') return '';

  let str = rawName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (!keepInitials) {
    str = str.replace(/\b[a-z]{1,2}\.(?:\s*[a-z]{1,2}\.)*/g, '');
  }

  const cleaned = str
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const minLen = keepInitials ? 1 : 2;
  const tokens = cleaned
    .split(' ')
    .filter((token) => token.length >= minLen && !STOP_TOKENS.has(token));

  return tokens.join(' ');
}

function extractFantaInitial(fantaName) {
  if (!fantaName) return null;
  const match = fantaName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .match(/\b([a-zA-Z]{1,2})\.(?:\s*[a-zA-Z]{1,2}\.)*$/);
  return match ? match[1].toLowerCase() : null;
}

function extractApiFirstNamePrefix(apiName) {
  if (!apiName) return null;
  const fantaInit = extractFantaInitial(apiName);
  if (fantaInit) return fantaInit;

  const normWithInit = normalizePlayerName(apiName, true);
  const tokens = normWithInit.split(' ').filter(Boolean);
  if (tokens.length > 1) {
    return tokens[0];
  }
  return null;
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

export class PlayerMatcher {
  constructor({ includeGoalkeepers = true } = {}) {
    this.includeGoalkeepers = includeGoalkeepers;
    this.allLocalPlayers = [];          // Lista completa dei giocatori di squads.json
    this.playersByNormName = new Map(); // normFull -> playerObj
    this.playersByExactRaw = new Map(); // rawLower -> playerObj
    this.aliasMap = new Map();
    this.surnameCounts = new Map();

    // Tracciamento per la telemetria invertita (centrata su squads.json)
    this.matchedLocalIds = new Set();   // ID dei giocatori di squads.json che hanno trovato corrispondenza
    this.activeSerieATeams = new Set(); // Squadre di Serie A effettivamente presenti nei match analizzati
    this.unmatchedApiPool = new Map();  // apiName -> { apiName, normBase, surnamePart, lastToken, normTeams, context }

    this.telemetry = {
      matched: new Map(),
      flagged: new Map()
    };
  }

  async init(squadsPath = DEFAULT_SQUADS_PATH, aliasPath = DEFAULT_ALIAS_PATH) {
    const squadsRaw = await fs.readFile(squadsPath, 'utf-8');
    const squads = JSON.parse(squadsRaw);

    for (const fantaTeam of squads) {
      const fantaTeamName = fantaTeam.squadra;
      const roster = Array.isArray(fantaTeam.giocatori) ? fantaTeam.giocatori : [];

      for (const p of roster) {
        const role = (p.ruolo || '').toUpperCase();
        if (!this.includeGoalkeepers && role === 'P') continue;

        const normFull = normalizePlayerName(p.nome, true);
        const normBase = normalizePlayerName(p.nome, false);
        const baseTokens = normBase.split(' ').filter(Boolean);
        const lastToken = baseTokens[baseTokens.length - 1] || normBase;
        const initial = extractFantaInitial(p.nome);

        const playerObj = {
          id: p.id || `${p.nome}_${fantaTeamName}`,
          nome: p.nome,
          ruolo: role,
          fantaSquadra: fantaTeamName,
          squadra: p.squadraSerieA,
          squadraNorm: normalizeTeamName(p.squadraSerieA),
          prezzoAcquisto: p.prezzoAcquisto,
          normFull,
          normBase,
          lastToken,
          initial
        };

        this.allLocalPlayers.push(playerObj);

        if (normFull) {
          this.playersByNormName.set(normFull, playerObj);
        }
        if (normBase) {
          this.surnameCounts.set(normBase, (this.surnameCounts.get(normBase) || 0) + 1);
        }
        this.playersByExactRaw.set(p.nome.toLowerCase().trim(), playerObj);
      }
    }

    try {
      const aliasRaw = await fs.readFile(aliasPath, 'utf-8');
      const parsedAliases = JSON.parse(aliasRaw);

      for (const [apiKey, targetVal] of Object.entries(parsedAliases)) {
        if (apiKey.startsWith('_')) continue;
        this.aliasMap.set(apiKey.toLowerCase().trim(), targetVal);
        const normAliasKey = normalizePlayerName(apiKey, true);
        if (normAliasKey) {
          this.aliasMap.set(normAliasKey, targetVal);
        }
      }
    } catch (err) {
      console.warn(`⚠️ [PlayerMatcher] Impossibile caricare alias_map.json (${err.message}).`);
    }
  }

  match(apiPlayerName, { allowedTeams = [], context = '' } = {}) {
    if (!apiPlayerName) return null;

    const rawTrimmed = apiPlayerName.trim();
    const rawLower = rawTrimmed.toLowerCase();

    if (NON_PLAYER_OUTCOMES.has(rawLower)) return null;

    const normApiFull = normalizePlayerName(rawTrimmed, true);
    const normApiBase = normalizePlayerName(rawTrimmed, false);

    if (!normApiFull) return null;

    const normAllowedTeams = allowedTeams.map((t) => normalizeTeamName(t)).filter(Boolean);
    for (const t of normAllowedTeams) {
      this.activeSerieATeams.add(t);
    }

    // --- STEP 1: LOOKUP DETERMINISTICO IN ALIAS_MAP.JSON ---
    const aliasTarget = this.aliasMap.get(rawLower) || this.aliasMap.get(normApiFull);
    if (aliasTarget) {
      if (aliasTarget === '__IGNORE__') return null;

      const targetPlayer =
        this.playersByExactRaw.get(aliasTarget.toLowerCase().trim()) ||
        this.playersByNormName.get(normalizePlayerName(aliasTarget, true));

      if (targetPlayer) {
        this._recordMatched(rawTrimmed, targetPlayer, 'ALIAS_MAP', 1.0);
        return { player: targetPlayer, score: 1.0, method: 'ALIAS_MAP', flagged: false };
      } else {
        // Mappato in alias_map ma svincolato o portiere: non lo aggiungiamo nemmeno al pool dei dubbi
        return null;
      }
    }

    // --- STEP 2: EXACT MATCH SULLA CHIAVE COMPLETA ---
    if (this.playersByNormName.has(normApiFull)) {
      const exactPlayer = this.playersByNormName.get(normApiFull);
      if (this._isTeamCompatible(exactPlayer, normAllowedTeams)) {
        this._recordMatched(rawTrimmed, exactPlayer, 'EXACT_FULL', 1.0);
        return { player: exactPlayer, score: 1.0, method: 'EXACT_FULL', flagged: false };
      }
    }

    const apiFirstPrefix = extractApiFirstNamePrefix(rawTrimmed);
    const compatiblePlayers = this.allLocalPlayers.filter(
      (p) =>
        this._isTeamCompatible(p, normAllowedTeams) &&
        this._areInitialsCompatible(p.initial, apiFirstPrefix)
    );

    const apiTokens = normApiBase.split(' ').filter(Boolean);
    const apiSurnameTokens = apiTokens.length > 1 ? apiTokens.slice(1) : apiTokens;
    const apiSurnamePart = apiSurnameTokens.join(' ');
    const apiLastToken = apiSurnameTokens[apiSurnameTokens.length - 1] || normApiBase;

    if (compatiblePlayers.length === 0) {
      this._recordUnmatchedApi(rawTrimmed, normApiBase, apiSurnamePart, apiLastToken, normAllowedTeams, context);
      return null;
    }

    // --- STEP 3: EXACT MATCH SU SOTTO-FRASE O TOKEN DEL COGNOME ---
    const tokenMatches = compatiblePlayers.filter((p) => {
      const localTokens = p.normBase.split(' ');
      if (localTokens.length > 1) {
        return ` ${normApiBase} `.includes(` ${p.normBase} `);
      } else {
        const singleToken = localTokens[0];
        return singleToken.length >= 4 && apiSurnameTokens.includes(singleToken);
      }
    });

    if (tokenMatches.length === 1) {
      const matchedPlayer = tokenMatches[0];
      const isAmbiguous = (this.surnameCounts.get(matchedPlayer.normBase) || 0) > 1;
      if (!isAmbiguous || apiFirstPrefix) {
        this._recordMatched(rawTrimmed, matchedPlayer, 'EXACT_TOKEN', 0.96);
        return { player: matchedPlayer, score: 0.96, method: 'EXACT_TOKEN', flagged: false };
      }
    }

    // --- STEP 4: FUZZY MATCH SUL COGNOME (CON PROTEZIONE COGNOMI CORTI E INIZIALI) ---
    // Filtriamo candidati: se il giocatore locale ha un'iniziale (es. 'Ramos G.'),
    // rifiutiamo il fuzzy match se l'API non ha fornito la lettera 'g'
    const fuzzyEligiblePlayers = compatiblePlayers.filter((p) =>
      this._areInitialsCompatible(p.initial, apiFirstPrefix, true)
    );

    if (fuzzyEligiblePlayers.length === 0) {
      this._recordUnmatchedApi(rawTrimmed, normApiBase, apiSurnamePart, apiLastToken, normAllowedTeams, context);
      return null;
    }

    const candidateKeys = fuzzyEligiblePlayers.map((p) => p.normBase);
    const surnamePartMatch = stringSimilarity.findBestMatch(apiSurnamePart, candidateKeys);
    let bestScore = surnamePartMatch.bestMatch.rating;
    let bestIndex = surnamePartMatch.bestMatchIndex;
    let matchMethod = 'FUZZY_SURNAME';

    if (apiLastToken && apiLastToken.length >= 5) {
      const lastTokenMatch = stringSimilarity.findBestMatch(apiLastToken, candidateKeys);
      if (lastTokenMatch.bestMatch.rating > bestScore) {
        bestScore = lastTokenMatch.bestMatch.rating;
        bestIndex = lastTokenMatch.bestMatchIndex;
        matchMethod = 'FUZZY_LAST_TOKEN';
      }
    }

    const bestCandidatePlayer = fuzzyEligiblePlayers[bestIndex];
    const surnameLen = Math.min(apiSurnamePart.length, bestCandidatePlayer.normBase.length);
    const dynamicThreshold = this._getMinFuzzyThreshold(surnameLen);

    // Blocco esplicito di collisioni fonetiche note (Ramon vs Ramos)
    const isRamonRamosCollision =
      (apiSurnamePart === 'ramon' && bestCandidatePlayer.normBase === 'ramos') ||
      (apiSurnamePart === 'ramos' && bestCandidatePlayer.normBase === 'ramon');

    if (bestScore >= dynamicThreshold && !isRamonRamosCollision) {
      const isLowConfidence = bestScore < HIGH_CONFIDENCE_THRESHOLD;
      this._recordMatched(rawTrimmed, bestCandidatePlayer, matchMethod, bestScore, isLowConfidence, context);

      return {
        player: bestCandidatePlayer,
        score: Number(bestScore.toFixed(2)),
        method: matchMethod,
        flagged: isLowConfidence
      };
    }

    this._recordUnmatchedApi(rawTrimmed, normApiBase, apiSurnamePart, apiLastToken, normAllowedTeams, context);
    return null;
  }

  /**
   * Calcola la similarità massima tra un giocatore locale di squads.json e un nome API rimasto non associato
   */
  _computeCandidateSimilarity(localPlayer, apiItem) {
    const s1 = stringSimilarity.compareTwoStrings(localPlayer.normBase, apiItem.surnamePart);
    const s2 = stringSimilarity.compareTwoStrings(localPlayer.normBase, apiItem.normBase);
    const s3 = stringSimilarity.compareTwoStrings(localPlayer.lastToken, apiItem.lastToken);

    // Bonus se uno dei token del giocatore locale compare come sottostringa nel nome API
    const substringBonus =
      localPlayer.lastToken.length >= 4 && apiItem.normBase.includes(localPlayer.lastToken) ? 0.75 : 0;

    return Math.max(s1, s2, s3, substringBonus);
  }

  /**
   * Verifica compatibilità delle iniziali.
   * Se requireStrict è true (durante un fuzzy match), l'iniziale DEVE essere presente e coincidere.
   */
  _areInitialsCompatible(localInitial, apiFirstPrefix, requireStrict = false) {
    if (!localInitial) return true;
    if (!apiFirstPrefix) {
      // Se stiamo facendo un fuzzy match e il giocatore locale ha un'iniziale (es. Ramos G.),
      // non possiamo accettare una parola priva di iniziale!
      return !requireStrict;
    }
    return apiFirstPrefix.startsWith(localInitial) || localInitial.startsWith(apiFirstPrefix);
  }

  /**
   * Calcola la soglia minima di similarità: per cognomi corti (<= 5 lettere)
   * una differenza di 1 lettera (es. Ramon vs Ramos = 0.75) deve essere scartata.
   */
  _getMinFuzzyThreshold(wordLength) {
    return wordLength <= 5 ? 0.88 : FUZZY_MIN_THRESHOLD;
  }

  _isTeamCompatible(playerObj, normAllowedTeams) {
    if (!normAllowedTeams || normAllowedTeams.length === 0 || !playerObj.squadraNorm) return true;
    return normAllowedTeams.some(
      (allowed) => allowed.includes(playerObj.squadraNorm) || playerObj.squadraNorm.includes(allowed)
    );
  }

  _recordMatched(apiName, playerObj, method, confidence, isFlagged = false, context = '') {
    this.matchedLocalIds.add(playerObj.id);
    // Se questo nome API era finito in precedenza negli unmatched, lo rimuoviamo
    this.unmatchedApiPool.delete(apiName);

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

  _recordUnmatchedApi(apiName, normBase, surnamePart, lastToken, normTeams, context) {
    if (this.telemetry.matched.has(apiName)) return;
    this.unmatchedApiPool.set(apiName, {
      apiName,
      normBase,
      surnamePart,
      lastToken,
      normTeams,
      context: context || 'N/A'
    });
  }

  /**
   * Stampa il report di telemetria invertito:
   * Mostra i giocatori di squads.json che non hanno ricevuto quote e affianca i nomi API più simili del loro match!
   */
  printTelemetryReport(sourceLabel = 'The Odds API') {
    const totalLocal = this.allLocalPlayers.length;
    const matchedLocalCount = this.matchedLocalIds.size;
    const flaggedCount = this.telemetry.flagged.size;

    // Filtriamo i giocatori di squads.json che NON sono stati associati
    const unmatchedLocalPlayers = this.allLocalPlayers.filter((p) => !this.matchedLocalIds.has(p.id));

    // Separiamo quelli la cui squadra di Serie A era presente nel feed da quelli la cui partita non era proprio quotata
    const unmatchedInActiveTeams = unmatchedLocalPlayers.filter((p) =>
      Array.from(this.activeSerieATeams).some(
        (activeTeam) => activeTeam.includes(p.squadraNorm) || p.squadraNorm.includes(activeTeam)
      )
    );
    const unmatchedInactiveTeamsCount = unmatchedLocalPlayers.length - unmatchedInActiveTeams.length;

    console.log('\n================================================================================');
    console.log(`📡 TELEMETRIA DATA MATCHING (${sourceLabel})`);
    console.log('================================================================================');
    console.log(
      `📊 Rose squads.json: ${matchedLocalCount}/${totalLocal} associati | ❌ Non associati (in match attivi): ${unmatchedInActiveTeams.length} | ⚠️ Bassa Confidenza: ${flaggedCount}`
    );
    if (unmatchedInactiveTeamsCount > 0) {
      console.log(
        `ℹ️  (${unmatchedInactiveTeamsCount} giocatori appartengono a squadre di Serie A senza quote/partita nel feed)`
      );
    }
    console.log('--------------------------------------------------------------------------------');

    // 1. MATCH A BASSA CONFIDENZA
    if (flaggedCount > 0) {
      console.warn('\n⚠️ WARNING: MATCH A BASSA CONFIDENZA (Verifica se corretti):');
      for (const item of this.telemetry.flagged.values()) {
        console.warn(
          `   🔸 "${item.targetName}" [${item.realTeam} - ${item.fantaTeam}]  associato a "${item.apiName}" (Confidenza: ${item.confidence})`
        );
      }
    } else {
      console.log('\n✨ Nessun match dubbio! Tutte le associazioni effettuate hanno alta confidenza.');
    }

    // 2. GIOCATORI DI SQUADS.JSON NON ASSOCIATI + CANDIDATI API PIÙ VICINI
    if (unmatchedInActiveTeams.length > 0) {
      const allUnmatchedApi = Array.from(this.unmatchedApiPool.values());

      // Per ogni giocatore di squads.json non associato, cerchiamo i candidati API più vicini nella SUA partita
      const reportRows = unmatchedInActiveTeams.map((localPlayer) => {
        // Filtra i nomi API scartati appartenenti alla partita della squadra del giocatore
        const sameMatchApiCandidates = allUnmatchedApi.filter((apiItem) =>
          apiItem.normTeams.some(
            (t) => t.includes(localPlayer.squadraNorm) || localPlayer.squadraNorm.includes(t)
          )
        );

        const poolToSearch = sameMatchApiCandidates.length > 0 ? sameMatchApiCandidates : allUnmatchedApi;

        const rankedCandidates = poolToSearch
          .map((apiItem) => ({
            apiName: apiItem.apiName,
            context: apiItem.context,
            score: Number(this._computeCandidateSimilarity(localPlayer, apiItem).toFixed(2))
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 3); // Prende i 3 nomi più vicini

        const topScore = rankedCandidates[0]?.score || 0;
        return {
          localPlayer,
          rankedCandidates,
          topScore
        };
      });

      // Ordiniamo mostrando in alto i giocatori di squads.json che hanno un candidato molto simile (probabile mismatch di nome!)
      reportRows.sort((a, b) => b.topScore - a.topScore);

      const likelyMismatches = reportRows.filter((r) => r.topScore >= 0.42);
      const likelyNotQuoted = reportRows.filter((r) => r.topScore < 0.42);

      if (likelyMismatches.length > 0) {
        console.log('\n🔍 PROBABILI ALIAS MANCANTI (Giocatori di squads.json con nomi simili nel feed):');
        for (const row of likelyMismatches) {
          const p = row.localPlayer;
          const suggestions = row.rankedCandidates
            .filter((c) => c.score >= 0.35)
            .map((c) => `"${c.apiName}" (${c.score})`)
            .join(', ');

          console.log(
            `   ❌ "${p.nome}" [${p.squadra} - ${p.fantaSquadra}] ➔ Candidati API: ${suggestions}`
          );
        }

        // Genera uno snippet pronto da copiare in alias_map.json per il primo candidato di ogni riga
        console.log('\n💡 Snippet suggerito per src/data/alias_map.json (verifica prima di incollare):');
        for (const row of likelyMismatches) {
          const bestCand = row.rankedCandidates[0];
          if (bestCand && bestCand.score >= 0.45) {
            console.log(`   "${bestCand.apiName}": "${row.localPlayer.nome}",`);
          }
        }
      }

      if (likelyNotQuoted.length > 0) {
        console.log(
          `\n🛌 GIOCATORI DI SQUADS.JSON NON QUOTATI DAI BOOKMAKER (${likelyNotQuoted.length} - infortunati, squalificati o riserve):`
        );
        for (const row of likelyNotQuoted) {
          const p = row.localPlayer;
          const bestCand = row.rankedCandidates[0];
          const bestHint = bestCand ? ` | Più vicino nel match: "${bestCand.apiName}" (${bestCand.score})` : '';
          console.log(`   - "${p.nome}" [${p.squadra} - ${p.fantaSquadra}]${bestHint}`);
        }
      }
    }

    console.log('================================================================================\n');
  }
}