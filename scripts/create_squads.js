import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Acquisizione dei parametri da linea di comando
const args = process.argv.slice(2);

if (args.length < 2) {
    console.error("Error: missing arguments.");
    console.error("Usage: node create_squads.js <path_file_excel> <path_file_csv>");
    process.exit(1);
}

const EXCEL_FILE = args[0];
const CSV_FILE = args[1];

const OUTPUT_DIR = path.join(__dirname, '..', 'src', 'data');
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'squads.json');

async function generaRoster() {
    try {
        // 2. Lettura Anagrafica con ExcelJS
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(EXCEL_FILE);
        
        // Cerca il foglio 'Tutti', altrimenti prende il primo disponibile
        const worksheet = workbook.getWorksheet('Tutti') || workbook.worksheets[0];
        const anagraficaGiocatori = new Map();
        
        // Mappatura dinamica delle colonne basata sulla riga 2 (intestazioni)
        let colId, colNome, colRuolo, colSquadra;
        const rigaIntestazioni = worksheet.getRow(2);
        
        rigaIntestazioni.eachCell((cell, colNumber) => {
            const valore = cell.value ? String(cell.value).trim() : '';
            if (valore === 'Id') colId = colNumber;
            if (valore === 'Nome') colNome = colNumber;
            if (valore === 'R') colRuolo = colNumber;
            if (valore === 'Squadra') colSquadra = colNumber;
        });

        // Iterazione sui dati reali (dalla riga 3 in poi)
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber > 2) {
                const id = row.getCell(colId).value;
                if (id) {
                    anagraficaGiocatori.set(String(id), {
                        nome: row.getCell(colNome).value,
                        ruolo: row.getCell(colRuolo).value,
                        squadra: row.getCell(colSquadra).value
                    });
                }
            }
        });

        // 3. Lettura Rose delle Squadre (CSV)
        const csvDati = fs.readFileSync(CSV_FILE, 'utf-8');
        const righeCSV = csvDati.split(/\r?\n/).filter(riga => riga.trim() !== '');
        const squadreFanta = {};

        // i = 1 per saltare la prima riga di intestazioni del CSV
        for (let i = 1; i < righeCSV.length; i++) {
            const colonne = righeCSV[i].split(',');
            
            if (colonne.length >= 3) {
                const nomeSquadra = colonne[0].trim();
                const idGiocatore = colonne[1].trim();
                const prezzo = colonne[2].trim();

                // Salta le righe sporche che contengono il simbolo del dollaro
                if (nomeSquadra === '$' || idGiocatore === '$' || prezzo === '$') {
                    continue; 
                }

                if (!squadreFanta[nomeSquadra]) {
                    squadreFanta[nomeSquadra] = {
                        squadra: nomeSquadra,
                        giocatori: []
                    };
                }

                // Recupero delle info anagrafiche
                const infoGiocatore = anagraficaGiocatori.get(idGiocatore) || {
                    nome: 'Sconosciuto',
                    ruolo: 'N/D',
                    squadra: 'N/D'
                };

                squadreFanta[nomeSquadra].giocatori.push({
                    id: idGiocatore,
                    nome: infoGiocatore.nome,
                    ruolo: infoGiocatore.ruolo,
                    squadraSerieA: infoGiocatore.squadra,
                    prezzoAcquisto: parseInt(prezzo, 10) || 0
                });
            }
        }

        // 4. Salvataggio in JSON
        const risultato = Object.values(squadreFanta);
        fs.writeFileSync(OUTPUT_JSON, JSON.stringify(risultato, null, 4), 'utf-8');
        
        console.log(`Esportazione completata. Generato il file: ${OUTPUT_JSON}`);

    } catch (error) {
        console.error("Si è verificato un errore durante l'elaborazione:", error.message);
    }
}

generaRoster();
