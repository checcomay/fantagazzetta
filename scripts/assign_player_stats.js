import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);

if (args.length < 1) {
    console.error("Errore: Argomenti mancanti.");
    console.error("Uso corretto: node scripts/assign_player_stats.js <path_league_players.csv>");
    process.exit(1);
}

const CSV_STATS_FILE = args[0];
const DATA_DIR = path.join(__dirname, '..', 'src', 'data');
const SQUADS_JSON = path.join(DATA_DIR, 'squads.json');
const OUTPUT_JSON = path.join(DATA_DIR, 'player_stats.json');

function normalize(str) {
    if (!str) return '';
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
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

        // 1. Lettura dei dati raggruppati per squadra
        const rawJson = fs.readFileSync(SQUADS_JSON, 'utf-8');
        const squadreFanta = JSON.parse(rawJson);

        // 2. Lettura del file CSV delle statistiche
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

        // Nuovo array che conterrà solo l'elenco piatto dei giocatori
        const giocatoriFlat = [];

        // 3. Estrazione, Incrocio dei dati e Costruzione dell'array piatto
        squadreFanta.forEach(team => {
            team.giocatori.forEach(giocatore => {
                const normSquadra = normalize(giocatore.squadraSerieA);
                const searchKey = getSearchKey(giocatore.nome);

                const matchedStat = statsData.find(stat => {
                    const csvTeam = normalize(stat.team);
                    const csvName = normalize(stat.player);
                    
                    const teamMatch = csvTeam.includes(normSquadra) || normSquadra.includes(csvTeam);
                    const nameMatch = csvName.includes(searchKey);
                    
                    return teamMatch && nameMatch;
                });

                let statistiche = { apps: 0, min: 0, goals: 0, assists: 0, xG: 0, xA: 0, xG90: 0, xA90: 0 };
                
                if (matchedStat) {
                    statistiche = {
                        apps: matchedStat.apps,
                        min: matchedStat.min,
                        goals: matchedStat.goals,
                        assists: matchedStat.assists,
                        xG: matchedStat.xG,
                        xA: matchedStat.xA,
                        xG90: matchedStat.xG90,
                        xA90: matchedStat.xA90
                    };
                }

                // Push del giocatore nel nuovo array con l'aggiunta di "fantaSquadra"
                giocatoriFlat.push({
                    id: giocatore.id,
                    nome: giocatore.nome,
                    ruolo: giocatore.ruolo,
                    squadraSerieA: giocatore.squadraSerieA,
                    fantaSquadra: team.squadra, // <-- Attributo aggiunto
                    prezzoAcquisto: giocatore.prezzoAcquisto,
                    stats: statistiche
                });
            });
        });

        // 4. Salvataggio del nuovo formato piatto
        fs.writeFileSync(OUTPUT_JSON, JSON.stringify(giocatoriFlat, null, 4), 'utf-8');
        console.log(`Statistiche assegnate con successo! Generato elenco piatto in: ${OUTPUT_JSON}`);

    } catch (error) {
        console.error("Si è verificato un errore:", error.message);
    }
}

assignStats();
