import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import * as cheerio from 'cheerio';
import stringSimilarity from 'string-similarity';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== CONFIGURAZIONE ====================
const TARGET_URL = 'https://www.fantacalcio.it/probabili-formazioni-serie-a';
const SQUADS_PATH = path.resolve(__dirname, '../src/data/squads.json');
const OUTPUT_PATH = path.resolve(__dirname, '../src/data/prob_indeces.json');

// Valore di default di probabilità di titolarità per i giocatori in dubbio
const DEFAULT_DOUBT_PROB = 5;

export const PLAYER_STATUS = Object.freeze({
  INDISPONIBILE: 'indisponibile',
  IN_DUBBIO: 'in_dubbio',
  BALLOTTAGGIO: 'ballottaggio',
  TITOLARE: 'titolare',
  PANCHINA: 'panchina'
});

export const ALL_STATUSES = Object.values(PLAYER_STATUS);

// Normalizzazione stringhe migliorata dei nomi dei giocatori
function normalizeName(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fuzzy matching tra il nome nel JSON locale e la lista estratta dal sito
 */
function findBestMatch(localName, scrapedMap) {
  const normLocal = normalizeName(localName);
  const scrapedKeys = Array.from(scrapedMap.keys());

  if (scrapedKeys.length === 0 || !normLocal) return null;

  // 0. Match esatto immediato o inclusione diretta (es. "milinkovic savic" vs "milinkovic savic")
  if (scrapedMap.has(normLocal)) {
    return scrapedMap.get(normLocal);
  }

  // 1. Confronto sul nome intero normalizzato
  const match = stringSimilarity.findBestMatch(normLocal, scrapedKeys);
  let bestScore = match.bestMatch.rating;
  let bestTarget = match.bestMatch.target;

  // 2. Fallback sui singoli token del nome (es. "Ederson" o "Kvaratskhelia")
  const parts = normLocal.split(' ').filter(p => p.length >= 3);
  for (const part of parts) {
    if (scrapedMap.has(part)) {
      return scrapedMap.get(part);
    }
    const partMatch = stringSimilarity.findBestMatch(part, scrapedKeys);
    if (partMatch.bestMatch.rating > bestScore && partMatch.bestMatch.rating >= 0.82) {
      bestScore = partMatch.bestMatch.rating;
      bestTarget = partMatch.bestMatch.target;
    }
  }

  if (bestScore >= 0.6) {
    return scrapedMap.get(bestTarget);
  }

  return null;
}

// ==================== SCRAPING FANTACALCIO.IT ====================

async function scrapeProbabiliFormazioni(url) {
  const response = await axios.get(url, { 
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } 
  });
  const $ = cheerio.load(response.data);
  const playersMap = new Map();

  // Priorità degli status: indisponibile > in_dubbio > ballottaggio > titolare > panchina
  const statusPriority = {
    [PLAYER_STATUS.INDISPONIBILE]: 5,
    [PLAYER_STATUS.IN_DUBBIO]: 4,
    [PLAYER_STATUS.BALLOTTAGGIO]: 3,
    [PLAYER_STATUS.TITOLARE]: 2,
    [PLAYER_STATUS.PANCHINA]: 1
  };

  const registerPlayer = (name, percent, status, forceStatus = false) => {
    if (!name) return;
    
    // Pulizia da percentuali residue, note tra parentesi e numeri
    const cleanName = name
      .replace(/\([^)]*\)/g, '')
      .replace(/[0-9]+%/g, '')
      .replace(/[^a-zA-ZàèéìòùÀÈÉÌÒÙ\s\.\'-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
      
    if (!cleanName || cleanName.length < 2) return;

    const bannedWords = [
      'NESSUNO', 'INFORTUNATI', 'SQUALIFICATI', 'PANCHINA', 
      'BALLOTTAGGI', 'IN DUBBIO', 'INDISPONIBILI', 'ALL', 'FORMAZIONE',
      'DIFFIDATI', 'DIFFIDATO', 'CAUTIONEDS'
    ];
    if (bannedWords.includes(cleanName.toUpperCase())) return;

    const normKey = normalizeName(cleanName);
    if (!normKey || normKey.length < 2) return;

    const existing = playersMap.get(normKey);

    if (!existing || forceStatus) {
      playersMap.set(normKey, { nome: cleanName, percentuale: percent, status });
      return;
    }

    const isHigherPriority = statusPriority[status] > statusPriority[existing.status];
    const isSamePriorityHigherPct = statusPriority[status] === statusPriority[existing.status] && percent > existing.percentuale;

    if (isHigherPriority || isSamePriorityHigherPct) {
      playersMap.set(normKey, { 
        nome: cleanName, 
        percentuale: status === PLAYER_STATUS.INDISPONIBILE ? 0 : Math.max(existing.percentuale, percent), 
        status: isHigherPriority ? status : existing.status 
      });
    }
  };

  // Helper universale per estrarre nome e % da qualsiasi nodo giocatore
  const extractPlayerFromNode = ($node) => {
    // Cerca il nome nei selettori tipici di Fantacalcio.it
    let pName = $node.find('.player-name, .name, a.player-link, a').first().text().trim();
    if (!pName && ($node.hasClass('player-name') || $node.is('a'))) {
      pName = $node.text().trim();
    }

    // Cerca la percentuale nel nodo o nel genitore diretto (es. .player-item o <li>)
    const $scope = $node.closest('li, .player-item, .player, .col, div');
    let pVal = null;

    const percentMatch = ($node.text() + ' ' + $scope.text()).match(/(\d{1,3})\s*%/);
    if (percentMatch) {
      pVal = parseInt(percentMatch[1], 10);
    } else {
      // Controlla se la percentuale è in un attributo style/aria-valuenow della progress bar
      const $bar = $scope.find('[aria-valuenow], [style*="width"]');
      if ($bar.length > 0) {
        const ariaVal = parseInt($bar.attr('aria-valuenow'), 10);
        if (!isNaN(ariaVal)) pVal = ariaVal;
      }
    }

    return { pName, pVal };
  };

  // ============================================================================
  // FASE 1: Panchina (<ul class="player-list reserves"> o dopo <label>Panchina</label>)
  // ============================================================================
  $('ul.reserves li, .player-list.reserves li').each((_, el) => {
    const { pName, pVal } = extractPlayerFromNode($(el));
    if (pName) {
      registerPlayer(pName, pVal ?? 5, PLAYER_STATUS.PANCHINA, true);
    }
  });

  $('label').filter((_, el) => $(el).text().trim().toUpperCase() === 'PANCHINA').each((_, el) => {
    $(el).nextAll('ul.player-list').first().find('li').each((__, liEl) => {
      const { pName, pVal } = extractPlayerFromNode($(liEl));
      if (pName) {
        registerPlayer(pName, pVal ?? 5, PLAYER_STATUS.PANCHINA, true);
      }
    });
  });

  // ============================================================================
  // FASE 2: Titolari (Dentro <div class="card team-card ..."> e liste non-reserves)
  // ============================================================================
  $('.team-card, .card.team-card, ul.player-list:not(.reserves)').each((_, cardEl) => {
    const $card = $(cardEl);

    // Cerchiamo qualsiasi elemento giocatore all'interno di .team-card
    $card.find('.player-name, .player-item, li, a[href*="calciatori"]').each((__, node) => {
      const $node = $(node);

      // Escludi rigorosamente se il nodo si trova dentro Panchina, Ballottaggi o Infermeria/Squalifiche reali
      if (
        $node.closest('ul.reserves, .player-list.reserves, .ballot-list, [class*="ballot"], section.suspendeds, [class*="infirmary"], [class*="injured"]').length > 0      
      ) {
        return;
      }

      // Controlla che non appartenga a una lista preceduta dalla label "Panchina"
      const $parentList = $node.closest('ul');
      if ($parentList.length > 0) {
        const prevLabel = $parentList.prevAll('label, h4').first().text().trim().toUpperCase();
        if (prevLabel === 'PANCHINA') return;
      }

      const { pName, pVal } = extractPlayerFromNode($node);
      if (pName) {
        const normKey = normalizeName(pName);
        // Non sovrascrivere se è già stato bloccato in panchina in Fase 1
        if (playersMap.has(normKey) && playersMap.get(normKey).status === PLAYER_STATUS.PANCHINA) return;

        // Se nel campetto/card titolari non c'è % esplicita, un titolare di default ha 90%
        registerPlayer(pName, pVal ?? 90, 'titolare');
      }
    });
  });

  // ============================================================================
  // FASE 3: Ballottaggi (<ul class="ballot-list">)
  // ============================================================================
  $('.ballot-list li, [class*="ballot"] li').each((_, el) => {
    const { pName, pVal } = extractPlayerFromNode($(el));
    if (pName && pVal !== null) {
      registerPlayer(pName, pVal, PLAYER_STATUS.BALLOTTAGGIO, true);
    }
  });

  // ============================================================================
  // FASE 4: Squalificati -> status: 'indisponibile' (ESCLUSI I DIFFIDATI)
  // ============================================================================
  $('section.suspendeds, .suspended-list, [class*="suspended"]').each((_, sec) => {
    const $sec = $(sec);
    
    // Ignora se la sezione stessa è per i diffidati
    if ($sec.is('.cautioneds, [class*="caution"]') || $sec.closest('.cautioneds, [class*="caution"]').length > 0) {
      return;
    }

    // 4A. Estrazione da elementi puntuali (li, player-name, a)
    $sec.find('li, .player-name, a').each((__, item) => {
      const $item = $(item);

      // Scarta categoricamente se l'elemento è dentro una lista/blocco diffidati
      if ($item.closest('.cautioneds, [class*="caution"]').length > 0) return;

      // Scarta se il testo o un genitore fa riferimento ai soli diffidati
      const parentText = $item.parent().text().toUpperCase();
      if (parentText.includes('DIFFIDAT') && !parentText.includes('SQUALIFICAT')) return;

      const name = $item.text().trim();
      if (name) registerPlayer(name, 0, PLAYER_STATUS.INDISPONIBILE, true);
    });

    // 4B. Estrazione da testo libero (es. "Squalificati: Rossi, NOME - Diffidati: Bianchi")
    $sec.find('p, div, span').each((__, item) => {
      const $item = $(item);
      if ($item.children().length > 0) return;
      if ($item.closest('.cautioneds, [class*="caution"]').length > 0) return;

      let rawText = $item.text().trim();
      
      // Se il blocco include sia squalificati che diffidati, rimuovi tutta la parte sui diffidati
      if (/diffidat/i.test(rawText)) {
        rawText = rawText.split(/diffidat[ie]?[:\s]*/i)[0];
      }

      // Prendi solo ciò che segue "Squalificati"
      if (/squalificat/i.test(rawText)) {
        const parts = rawText.split(/squalificat[ie]?[:\s]*/i);
        rawText = parts[1] || '';
      } else {
        // Se non menziona esplicitamente "squalificati", potrebbe essere testo generico/diffidati: ignora
        return;
      }

      rawText.split(/,|\u2013|\-/).forEach(n => {
        const cleanItem = n.trim();
        if (cleanItem && !/nessuno/i.test(cleanItem)) {
          registerPlayer(cleanItem, 0, PLAYER_STATUS.INDISPONIBILE, true);
        }
      });
    });
  });

  // ============================================================================
  // FASE 5: Infortunati ('indisponibile') vs In Dubbio ('in_dubbio')
  // ============================================================================
  const parseMedicalBlock = ($container, defaultStatus) => {
    $container.find('li, .player-name, a, p').each((__, item) => {
      const $item = $(item);
      const fullItemText = $item.text().trim();
      if (!fullItemText) return;

      // Determina se lo specifico giocatore o sotto-blocco è "In dubbio"
      const isDoubtful = 
        defaultStatus === 'in_dubbio' || 
        /in\s*dubbio|da\s*valutare|recuperabile/i.test(fullItemText);

      const finalStatus = isDoubtful ? PLAYER_STATUS.IN_DUBBIO : PLAYER_STATUS.INDISPONIBILE;

      // Estrae eventuale percentuale
      const pctMatch = fullItemText.match(/(\d{1,3})\s*%/);
      const pctVal = pctMatch ? parseInt(pctMatch[1], 10) : (finalStatus === PLAYER_STATUS.IN_DUBBIO ? DEFAULT_DOUBT_PROB : 0);

      const pName = $item.find('.player-name').length > 0 
        ? $item.find('.player-name').first().text().trim() 
        : fullItemText.split(':')[0].trim();

      if (pName) {
        registerPlayer(pName, pctVal, finalStatus, true);
      }
    });
  };

  // 5A. Blocchi con icona Infermeria Voltaren (img.infirmary-label)
  $('img.infirmary-label').each((_, img) => {
    const $infirmarySection = $(img).closest('section, .infirmary, .injureds').length > 0
      ? $(img).closest('section, .infirmary, .injureds')
      : $(img).parent().parent();
    parseMedicalBlock($infirmarySection, PLAYER_STATUS.INDISPONIBILE);
  });

  // 5B. Sezioni distinte tramite header "Infortunati" o "In dubbio"
  $('h4, label, div, span, strong').each((_, header) => {
    const t = $(header).text().trim().toUpperCase();
    if (t === 'INFORTUNATI' || t === 'INDISPONIBILI') {
      parseMedicalBlock($(header).closest('section, div'), PLAYER_STATUS.INDISPONIBILE);
    } else if (t === 'IN DUBBIO' || t.startsWith('IN DUBBIO:')) {
      parseMedicalBlock($(header).closest('section, div'), PLAYER_STATUS.IN_DUBBIO);
    }
  });

  return playersMap;
}

// ==================== MAIN ====================

async function main() {
  console.log('🚀 Avvio elaborazione probabilità titolarità...');

  let squads = [];
  try {
    const raw = await fs.readFile(SQUADS_PATH, 'utf-8');
    squads = JSON.parse(raw);
    console.log(`📂 Letto correttamente ${SQUADS_PATH}`);
  } catch (err) {
    console.error(`❌ Errore lettura squads.json: ${err.message}`);
    process.exit(1);
  }

  let scrapedPlayersMap = new Map();
  try {
    scrapedPlayersMap = await scrapeProbabiliFormazioni(TARGET_URL);
    console.log(`🔍 Giocatori unici estratti da Fantacalcio.it: ${scrapedPlayersMap.size}`);
  } catch (err) {
    console.error(`❌ Errore durante lo scraping: ${err.message}`);
    process.exit(1);
  }

  const output = [];
  const unmatchedPlayers = [];
  let trovati = 0;
  let totali = 0;

  for (const fantaTeam of squads) {
    const teamName = fantaTeam.squadra;
    const players = Array.isArray(fantaTeam.giocatori) ? fantaTeam.giocatori : [];

    for (const player of players) {
      totali++;
      const match = findBestMatch(player.nome, scrapedPlayersMap);

      if (match) {
        trovati++;
        output.push({
          id: player.id,
          nome: player.nome,
          ruolo: player.ruolo,
          squadra_fanta: teamName,
          squadra_serie_a: player.squadraSerieA,
          probabilita_titolare: match.percentuale,
          status: match.status // 'titolare' | 'ballottaggio' | 'panchina' | 'in_dubbio' | 'indisponibile'
        });
      } else {
        unmatchedPlayers.push({
          nome: player.nome,
          squadra_serie_a: player.squadraSerieA,
          squadra_fanta: teamName
        });

        output.push({
          id: player.id,
          nome: player.nome,
          ruolo: player.ruolo,
          squadra_fanta: teamName,
          squadra_serie_a: player.squadraSerieA,
          probabilita_titolare: 0,
          status: PLAYER_STATUS.INDISPONIBILE
        });
      }
    }
  }

  output.sort((a, b) => b.probabilita_titolare - a.probabilita_titolare);

  try {
    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
    
    console.log(`\n🎉 Completato!`);
    console.log(`📊 Giocatori matchati correttamente: ${trovati}/${totali}`);
    
    if (unmatchedPlayers.length > 0) {
      console.log(`\n⚠️ GIOCATORI NON MATCHATI / IMPOSTATI COME INDISPONIBILI (${unmatchedPlayers.length}):`);
      unmatchedPlayers.forEach(p => {
        console.log(`   - ${p.nome} (${p.squadra_serie_a}) [Fantasquadra: ${p.squadra_fanta}]`);
      });
    } else {
      console.log(`\n✨ Ottimo! Tutti i giocatori sono stati matchati.`);
    }

    console.log(`\n💾 File salvato in: ${OUTPUT_PATH}`);
  } catch (err) {
    console.error(`❌ Errore salvataggio file: ${err.message}`);
    process.exit(1);
  }
}

main();