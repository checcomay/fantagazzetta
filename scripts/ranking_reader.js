import ExcelJS from 'exceljs';
import fs from 'fs';

const inputFile = process.argv[2];
const outputFile = '../src/data/standings.json';

async function convertiExcelInJson() {
    try {
        if (!fs.existsSync(inputFile)) {
            console.error(`Errore: Il file '${inputFile}' non esiste.`);
            process.exit(1);
        }

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(inputFile);

        // Prende il primo foglio
        const worksheet = workbook.worksheets[0];
        const data = [];
        
        // Mappa per associare la colonna al tipo di dato
        let headerRowIndex = -1;
        let colMap = {
            squadra: -1,
            posizione: -1,
            giornate: -1,
            vittorie: -1,
            pareggi: -1,
            sconfitte: -1,
            golFatti: -1,
            golSubiti: -1,
            puntiClassifica: -1,
            puntiTotali: -1
        };

        worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
            // Se abbiamo già trovato l'intestazione, questa è una riga di dati della squadra
            if (headerRowIndex !== -1 && rowNumber > headerRowIndex) {
                
                // Estrae la stringa "Squadra" pulita (se la cella fosse un oggetto hyperlink)
                let squadraVal = colMap.squadra !== -1 ? row.getCell(colMap.squadra).value : null;
                if (squadraVal && typeof squadraVal === 'object' && squadraVal.text) {
                    squadraVal = squadraVal.text;
                } else if (squadraVal) {
                    squadraVal = squadraVal.toString().trim();
                }

                // Aggiungiamo ai dati solo se c'è effettivamente un nome di squadra valido
                if (squadraVal && squadraVal !== "" && !squadraVal.includes("http")) {
                    const rowData = {
                        Squadra: squadraVal,
                        Posizione: colMap.posizione !== -1 ? row.getCell(colMap.posizione).value : null,
                        Vittorie: colMap.vittorie !== -1 ? row.getCell(colMap.vittorie).value : null,
                        Pareggi: colMap.pareggi !== -1 ? row.getCell(colMap.pareggi).value : null,
                        Sconfitte: colMap.sconfitte !== -1 ? row.getCell(colMap.sconfitte).value : null,
                        GolFatti: colMap.golFatti !== -1 ? row.getCell(colMap.golFatti).value : null,
                        GolSubiti: colMap.golSubiti !== -1 ? row.getCell(colMap.golSubiti).value : null,
                        PuntiClassifica: colMap.puntiClassifica !== -1 ? row.getCell(colMap.puntiClassifica).value : null,
                        PuntiTotali: colMap.puntiTotali !== -1 ? row.getCell(colMap.puntiTotali).value : null,
                        NumGiornate: colMap.giornate !== -1 ? row.getCell(colMap.giornate).value : null,
                    };
                    data.push(rowData);
                }
            } else if (headerRowIndex === -1) {
                // FASE DI RICERCA INTESTAZIONI
                let foundHeaders = false;
                row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                    if (cell.value) {
                        const val = cell.value.toString().trim().toLowerCase();
                        
                        // Cerca le colonne in base alle etichette tipiche di Fantacalcio
                        if (val === 'squadra' || val === 'squadre') colMap.squadra = colNumber;
                        if (val === 'pos' || val === 'pos.' || val === 'posizione') colMap.posizione = colNumber;
                        if (val === 'g' || val === 'giornata' || val === 'numero giornate') colMap.giornate = colNumber;
                        if (val === 'v' || val === 'vittorie') colMap.vittorie = colNumber;
                        if (val === 'n' || val === 'pari' || val === 'pareggi') colMap.pareggi = colNumber;
                        if (val === 'p' || val === 's' || val === 'sconfitte' || val === 'perse') colMap.sconfitte = colNumber;
                        if (val === 'gf' || val === 'gol fatti') colMap.golFatti = colNumber;
                        if (val === 'gs' || val === 'gol subiti') colMap.golSubiti = colNumber;
                        if (val === 'pt' || val === 'pt.' || val === 'punti') colMap.puntiClassifica = colNumber;
                        if (val === 'pt. totali' || val === 'punti totali') colMap.puntiTotali = colNumber;
                        
                        if (val === 'squadra' || val === 'squadre') {
                            foundHeaders = true;
                        }
                    }
                });

                // Se abbiamo trovato l'intestazione, applichiamo un layout standard di fallback per i campi che magari hanno intestazioni vuote o strane nell'Excel
                if (foundHeaders) {
                    headerRowIndex = rowNumber;
                    if(colMap.posizione === -1) colMap.posizione = 1;
                    if(colMap.giornate === -1) colMap.giornate = 4;
                    if(colMap.vittorie === -1) colMap.vittorie = 5;
                    if(colMap.pareggi === -1) colMap.pareggi = 6;
                    if(colMap.sconfitte === -1) colMap.sconfitte = 7;
                    if(colMap.golFatti === -1) colMap.golFatti = 8;
                    if(colMap.golSubiti === -1) colMap.golSubiti = 9;
                    if(colMap.puntiClassifica === -1) colMap.puntiClassifica = 11;
                    if(colMap.puntiTotali === -1) colMap.puntiTotali = 12;
                }
            }
        });

        // Scrivi i dati nel file JSON
        fs.writeFileSync(outputFile, JSON.stringify(data, null, 4), 'utf-8');
        console.log(`Conversione completata! I dati sono stati salvati in ${outputFile}`);

    } catch (error) {
        console.error("Errore durante la conversione:", error.message);
    }
}

convertiExcelInJson();