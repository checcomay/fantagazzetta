import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);

if (args.length < 1) {
    console.error("Error: missing arguments.");
    console.error("Usage: node scripts/assign_player_stats.js <path_league_players.csv>");
    process.exit(1);
}

const CSV_STATS_FILE = args[0];
const DATA_DIR = path.join(__dirname, '..', 'src', 'data');
const SQUADS_JSON = path.join(DATA_DIR, 'squads.json');
const OUTPUT_JSON = path.join(DATA_DIR, 'player_stats.json');
const ALIAS_MAP_FILE = path.join(DATA_DIR, 'alias_map.json');

function normalize(str) {
    if (!str) return '';
    return str.normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Rimuove gli accenti classici
        .toLowerCase()
        .replace(/ø/g, 'o')              // Converte la ø scandinava in o
        .replace(/æ/g, 'ae')             // Converte la æ in ae
        .replace(/å/g, 'a')              // Converte la å in a
        .replace(/ß/g, 'ss')             // Converte la ß tedesca in ss
        .replace(/[^a-z0-9\s.-]/g, '');  // Rimuove tutti gli altri simboli strani
}

function getSearchKey(name) {
    const clean = normalize(name).replace(/\./g, '');
    const parts = clean.split(' ');
    if (parts.length === 0) return '';
    return parts.reduce((longest, current) => current.length > longest.length ? current : longest, '');
}

function assignStats() {
    try {
        if (!fs.existsSync(SQUADS_JSON)) {
            throw new Error(`Il file ${SQUADS_JSON} non esiste. Esegui prima create_squads.js`);
        }

        // 1. Lettura dati rose
        const rawJson = fs.readFileSync(SQUADS_JSON, 'utf-8');
        const squadreFanta = JSON.parse(rawJson);

        // 2. Lettura Mappa Alias (se esiste)
        let aliasMap = {};
        if (fs.existsSync(ALIAS_MAP_FILE)) {
            const rawAlias = fs.readFileSync(ALIAS_MAP_FILE, 'utf-8');
            const parsedAlias = JSON.parse(rawAlias);
            // Normalizziamo le chiavi dell'alias map per evitare problemi di accenti (es. Højlund)
            for (const [key, value] of Object.entries(parsedAlias)) {
                aliasMap[normalize(key)] = normalize(value);
            }
        }

        // 3. Lettura CSV Statistiche
        const csvDati = fs.readFileSync(CSV_STATS_FILE, 'utf-8');
        const righeCSV = csvDati.split(/\r?\n/).filter(riga => riga.trim() !== '');
        const statsData = [];

        for (let i = 1; i < righeCSV.length; i++) {
            const colonne = righeCSV[i].split(';').map(val => val.replace(/"/g, '').trim());
            if (colonne.length >= 11) {
                statsData.push({
                    player: colonne[1],
                    team: colonne[2],
                    apps: parseInt(colonne[3], 10) || 0,
                    min: parseInt(colonne[4], 10) || 0,
                    goals: parseInt(colonne[5], 10) || 0,
                    assists: parseInt(colonne[6], 10) || 0,
                    xG: parseFloat(colonne[7].replace(',', '.')) || 0,
                    xA: parseFloat(colonne[8].replace(',', '.')) || 0,
                    xG90: parseFloat(colonne[9].replace(',', '.')) || 0,
                    xA90: parseFloat(colonne[10].replace(',', '.')) || 0
                });
            }
        }

        const giocatoriFlat = [];
        let matchedCount = 0;
        const unmatchedPlayers = [];

        // 4. Incrocio dati
        squadreFanta.forEach(team => {
            team.giocatori.forEach(giocatore => {
                if (giocatore.ruolo === 'P') return;

                const normSquadra = normalize(giocatore.squadraSerieA);
                const normNomeGiocatore = normalize(giocatore.nome);
                const searchKey = getSearchKey(giocatore.nome);

                const matchedStat = statsData.find(stat => {
                    const csvTeam = normalize(stat.team);
                    const csvNameOrig = normalize(stat.player);
                    
                    // Applica l'Alias Map: se il nome del CSV è mappato, usa il valore dell'alias, altrimenti il nome originale
                    const csvNameMapped = aliasMap[csvNameOrig] || csvNameOrig;
                    
                    const teamMatch = csvTeam.includes(normSquadra) || normSquadra.includes(csvTeam);
                    
                    // Controllo: o matcha il searchKey, oppure combacia perfettamente con l'alias tradotto
                    const nameMatch = csvNameMapped.includes(searchKey) || normNomeGiocatore.includes(csvNameMapped);
                    
                    return teamMatch && nameMatch;
                });

                let statistiche = { apps: 0, min: 0, goals: 0, assists: 0, xG: 0, xA: 0, xG90: 0, xA90: 0 };
                
                if (matchedStat) {
                    matchedCount++;
                    statistiche = {
                        apps: matchedStat.apps, min: matchedStat.min, goals: matchedStat.goals,
                        assists: matchedStat.assists, xG: matchedStat.xG, xA: matchedStat.xA,
                        xG90: matchedStat.xG90, xA90: matchedStat.xA90
                    };
                } else {
                    unmatchedPlayers.push(`${giocatore.nome} (${giocatore.squadraSerieA}) - ${team.squadra}`);
                }

                giocatoriFlat.push({
                    id: giocatore.id,
                    nome: giocatore.nome,
                    ruolo: giocatore.ruolo,
                    squadraSerieA: giocatore.squadraSerieA,
                    fantaSquadra: team.squadra,
                    prezzoAcquisto: giocatore.prezzoAcquisto,
                    stats: statistiche
                });
            });
        });

        // 5. Salvataggio e Report
        fs.writeFileSync(OUTPUT_JSON, JSON.stringify(giocatoriFlat, null, 4), 'utf-8');
        
        console.log(`\n=== REPORT ASSEGNAZIONE STATISTICHE ===`);
        console.log(`✅ Giocatori abbinati con successo: ${matchedCount}`);
        
        if (unmatchedPlayers.length > 0) {
            console.log(`\n⚠️ ATTENZIONE: ${unmatchedPlayers.length} giocatori non hanno trovato corrispondenza:`);
            unmatchedPlayers.forEach(p => console.log(`   - ${p}`));
            console.log(`\n(Suggerimento: aggiungi questi nomi nel file src/data/alias_map.json se si tratta di omonimie).`);
        } else {
            console.log(`\n🎉 Ottimo! Tutti i giocatori di movimento hanno trovato corrispondenza.`);
        }
        
        console.log(`\n💾 Salvataggio completato in: ${OUTPUT_JSON}\n`);

    } catch (error) {
        console.error("Si è verificato un errore:", error.message);
    }
}

assignStats();
