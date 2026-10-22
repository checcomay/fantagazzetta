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

// Normalizzazione stringhe (rimuove accenti, punteggiatura e porta in minuscolo)
function normalizeName(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b[a-z]\./g, '') // Rimuove iniziali puntate (es. "ro." in "sanchez ro.")
    .replace(/[^a-z0-9\s]/g, '')
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

  // 1. Confronto sul nome intero
  const match = stringSimilarity.findBestMatch(normLocal, scrapedKeys);
  let bestScore = match.bestMatch.rating;
  let bestTarget = match.bestMatch.target;

  // 2. Fallback sul solo cognome (es. "Khvicha Kvaratskhelia" vs "Kvaratskhelia")
  const parts = normLocal.split(' ');
  if (parts.length > 1) {
    const lastName = parts[parts.length - 1];
    const lastNameMatch = stringSimilarity.findBestMatch(lastName, scrapedKeys);
    if (lastNameMatch.bestMatch.rating > bestScore && lastNameMatch.bestMatch.rating >= 0.85) {
      bestScore = lastNameMatch.bestMatch.rating;
      bestTarget = lastNameMatch.bestMatch.target;
    }
  }

  if (bestScore >= 0.6) {
    return scrapedMap.get(bestTarget);
  }

  return null;
}

// ==================== SCRAPING FANTACALCIO.IT ====================

async function scrapeProbabiliFormazioni(url) {
  console.log(`🌐 Scaricamento pagina: ${url}...`);

  const response = await axios.get(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  });

  const $ = cheerio.load(response.data);
  // Mappa: nomeNormalizzato -> { nomeOriginale, percentuale, status }
  const playersMap = new Map();

  const registerPlayer = (name, percent, status) => {
    if (!name || isNaN(percent)) return;
    const cleanName = name.replace(/[^a-zA-ZàèéìòùÀÈÉÌÒÙ\s\.\'-]/g, '').trim();
    const normKey = normalizeName(cleanName);

    // Se il giocatore è già registrato (es. sia nel campo che nel ballottaggio), manteniamo la stima più accurata
    if (!playersMap.has(normKey) || playersMap.get(normKey).percentuale < percent) {
      playersMap.set(normKey, {
        nome: cleanName,
        percentuale: percent,
        status: status // 'titolare' | 'ballottaggio' | 'panchina'
      });
    }
  };

  // 1. Estrazione Ballottaggi (es. "Butez 55% - Sanchez Ro. 45%")
  // Cerca sezioni con classe o testo che contiene "Ballottaggi"
  $('*:contains("Ballottaggi")').each((_, el) => {
    const text = $(el).text();
    // Regex per catturare pattern come: "NomeGiocatore 55%" o "Nome Giocatore 60%"
    const regex = /([A-Za-zÀ-ÿ\.\s\'-]{2,20})\s+(\d{1,2})%/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const pName = match[1].trim();
      const pPercent = parseInt(match[2], 10);
      if (pName.toLowerCase() !== 'ballottaggi' && pPercent <= 100) {
        registerPlayer(pName, pPercent, 'ballottaggio');
      }
    }
  });

  // 2. Estrazione Titolari dal campo grafico / formazioni
  // Fantacalcio.it organizza i titolari con nodi giocatore e percentuali (es. "90%", "80%")
  // Selezioniamo elementi che contengono i nomi dei titolari
  $('li, div, span').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();

    // Se l'elemento contiene un pattern tipo "Perri 90%" o "Comuzzo 80%"
    const inlineMatch = text.match(/^([A-Za-zÀ-ÿ\.\s\'-]{2,20})\s+(\d{1,2})%$/);
    if (inlineMatch) {
      registerPlayer(inlineMatch[1], parseInt(inlineMatch[2], 10), 'titolare');
      return;
    }

    // Se la percentuale è in un tag separato o data-attribute adiacente
    const percentEl = $el.find('.percentage, .percent, [class*="percent"], [class*="rate"]');
    if (percentEl.length > 0) {
      const pText = percentEl.text().replace('%', '').trim();
      const pVal = parseInt(pText, 10);
      const nameEl = $el.clone().children().remove().end().text().trim();
      if (nameEl && !isNaN(pVal)) {
        registerPlayer(nameEl, pVal, 'titolare');
      }
    }
  });

  // Fallback: Se alcuni titolari non hanno percentuale esplicita nel DOM ma sono inseriti nel blocco titolari
  $('[class*="regular"], [class*="titolar"], [class*="lineup"]').find('a, span[class*="name"], .player-name').each((_, el) => {
    const name = $(el).text().trim();
    if (name && name.length > 2 && !playersMap.has(normalizeName(name))) {
      registerPlayer(name, 95, 'titolare'); // Assegna 95% di default ai titolari certi
    }
  });

  console.log(`✅ Estratti ${playersMap.size} giocatori con percentuali da Fantacalcio.it`);
  return playersMap;
}

// ==================== MAIN ====================

async function main() {
  console.log('🚀 Avvio elaborazione probabilità titolarità...');

  // 1. Carica squads.json
  let squads = [];
  try {
    const raw = await fs.readFile(SQUADS_PATH, 'utf-8');
    squads = JSON.parse(raw);
    console.log(`📂 Letto correttamente ${SQUADS_PATH}`);
  } catch (err) {
    console.error(`❌ Errore lettura squads.json: ${err.message}`);
    process.exit(1);
  }

  // 2. Scraping da Fantacalcio.it
  let scrapedPlayersMap = new Map();
  try {
    scrapedPlayersMap = await scrapeProbabiliFormazioni(TARGET_URL);
  } catch (err) {
    console.error(`❌ Errore durante lo scraping: ${err.message}`);
    process.exit(1);
  }

  // 3. Incrocio dati con i giocatori delle fantasquadre
  const output = [];
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
          status: match.status // 'titolare' | 'ballottaggio'
        });
      } else {
        // Giocatore in panchina / tribuna / non quotato tra i titolari o ballottaggi
        output.push({
          id: player.id,
          nome: player.nome,
          ruolo: player.ruolo,
          squadra_fanta: teamName,
          squadra_serie_a: player.squadraSerieA,
          probabilita_titolare: 5, // Stima base per chi siede in panchina
          status: 'panchina'
        });
      }
    }
  }

  // Ordina dal giocatore con la percentuale più alta a quella più bassa
  output.sort((a, b) => b.probabilita_titolare - a.probabilita_titolare);

  // 4. Salvataggio su file JSON
  try {
    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\n🎉 Completato!`);
    console.log(`📊 Giocatori matchati tra i titolari/ballottaggi: ${trovati}/${totali}`);
    console.log(`💾 File salvato in: ${OUTPUT_PATH}`);
  } catch (err) {
    console.error(`❌ Errore salvataggio file: ${err.message}`);
    process.exit(1);
  }
}

main();