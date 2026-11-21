import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Il file che conserverà tutte le date di esecuzione reali
const UPDATES_FILE = path.resolve(__dirname, '../../src/data/last_updates.json');

/**
 * Registra il timestamp corrente per una specifica categoria di dati.
 * @param {'squads' | 'stats' | 'ranking' | 'calendar' | 'lineups' | 'odds' | 'xfm'} key 
 */
export function recordDataUpdate(key) {
  let data = {};
  
  try {
    if (fs.existsSync(UPDATES_FILE)) {
      const raw = fs.readFileSync(UPDATES_FILE, 'utf-8');
      data = JSON.parse(raw);
    }
  } catch (err) {
    console.warn(`⚠️ Creazione nuovo file di tracking: ${UPDATES_FILE}`);
  }

  // Salva la data in formato standard ISO 8601
  data[key] = new Date().toISOString();

  fs.mkdirSync(path.dirname(UPDATES_FILE), { recursive: true });
  fs.writeFileSync(UPDATES_FILE, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`🕒 Timestamp [${key}] registrato in last_updates.json`);
}
