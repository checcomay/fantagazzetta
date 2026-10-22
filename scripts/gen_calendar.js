import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_INPUT_PATH = path.resolve(
  process.env.HOME || process.env.USERPROFILE,
  'Downloads/Calendario_Campionato-2026-27.xlsx'
);
const OUTPUT_PATH = path.resolve(__dirname, '../src/data/calendar.json');

function extractRoundNumber(text) {
  if (!text) return null;
  const match = String(text).match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function cleanCellValue(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object' && val.result !== undefined) {
    return val.result;
  }
  return val;
}

async function main() {
  const inputFilePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_INPUT_PATH;

  console.log(`📅 Lettura calendario da: ${inputFilePath}`);

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(inputFilePath);
  } catch (err) {
    console.error(`❌ Errore durante l'apertura del file Excel: ${err.message}`);
    process.exit(1);
  }

  const worksheet = workbook.worksheets[0];
  const roundsMap = new Map();

  // ExcelJS usa indici riga e colonna 1-based
  for (let r = 1; r <= worksheet.rowCount; r++) {
    const row = worksheet.getRow(r);

    const valLeft = cleanCellValue(row.getCell(1).value);
    const strLeft = valLeft ? String(valLeft).trim() : '';

    const valRight = cleanCellValue(row.getCell(7).value);
    const strRight = valRight ? String(valRight).trim() : '';

    // 1. Parsing Blocco Sinistro (colonne 1-5: giornate dispari)
    if (strLeft.includes('Giornata lega')) {
      const roundLega = extractRoundNumber(strLeft);
      const roundSerieA = extractRoundNumber(cleanCellValue(row.getCell(3).value));

      const matches = [];
      for (let i = 1; i <= 4; i++) {
        const matchRow = worksheet.getRow(r + i);
        const home = cleanCellValue(matchRow.getCell(1).value);
        const homePts = cleanCellValue(matchRow.getCell(2).value);
        const awayPts = cleanCellValue(matchRow.getCell(3).value);
        const away = cleanCellValue(matchRow.getCell(4).value);
        const score = cleanCellValue(matchRow.getCell(5).value);

        if (home && away) {
          const scoreStr = score !== null && score !== undefined ? String(score).trim() : '-';
          matches.push({
            home: String(home).trim(),
            away: String(away).trim(),
            score: scoreStr,
            home_points: homePts !== null && !isNaN(Number(homePts)) ? Number(homePts) : null,
            away_points: awayPts !== null && !isNaN(Number(awayPts)) ? Number(awayPts) : null,
            played: scoreStr !== '-' && scoreStr !== ''
          });
        }
      }

      if (roundLega) {
        roundsMap.set(roundLega, {
          round: roundLega,
          serie_a_round: roundSerieA,
          matches
        });
      }
    }

    // 2. Parsing Blocco Destro (colonne 7-11: giornate pari)
    if (strRight.includes('Giornata lega')) {
      const roundLega = extractRoundNumber(strRight);
      const roundSerieA = extractRoundNumber(cleanCellValue(row.getCell(9).value));

      const matches = [];
      for (let i = 1; i <= 4; i++) {
        const matchRow = worksheet.getRow(r + i);
        const home = cleanCellValue(matchRow.getCell(7).value);
        const homePts = cleanCellValue(matchRow.getCell(8).value);
        const awayPts = cleanCellValue(matchRow.getCell(9).value);
        const away = cleanCellValue(matchRow.getCell(10).value);
        const score = cleanCellValue(matchRow.getCell(11).value);

        if (home && away) {
          const scoreStr = score !== null && score !== undefined ? String(score).trim() : '-';
          matches.push({
            home: String(home).trim(),
            away: String(away).trim(),
            score: scoreStr,
            home_points: homePts !== null && !isNaN(Number(homePts)) ? Number(homePts) : null,
            away_points: awayPts !== null && !isNaN(Number(awayPts)) ? Number(awayPts) : null,
            played: scoreStr !== '-' && scoreStr !== ''
          });
        }
      }

      if (roundLega) {
        roundsMap.set(roundLega, {
          round: roundLega,
          serie_a_round: roundSerieA,
          matches
        });
      }
    }
  }

  const sortedRounds = Array.from(roundsMap.keys())
    .sort((a, b) => a - b)
    .map((k) => roundsMap.get(k));

  const teamsCalendar = {};
  for (const roundData of sortedRounds) {
    for (const match of roundData.matches) {
      if (!teamsCalendar[match.home]) teamsCalendar[match.home] = [];
      if (!teamsCalendar[match.away]) teamsCalendar[match.away] = [];

      teamsCalendar[match.home].push({
        round: roundData.round,
        serie_a_round: roundData.serie_a_round,
        is_home: true,
        opponent: match.away,
        score: match.score,
        team_points: match.home_points,
        opponent_points: match.away_points,
        played: match.played
      });

      teamsCalendar[match.away].push({
        round: roundData.round,
        serie_a_round: roundData.serie_a_round,
        is_home: false,
        opponent: match.home,
        score: match.score,
        team_points: match.away_points,
        opponent_points: match.home_points,
        played: match.played
      });
    }
  }

  const finalOutput = {
    total_rounds: sortedRounds.length,
    rounds: sortedRounds,
    teams: teamsCalendar
  };

  try {
    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(finalOutput, null, 2), 'utf-8');
    console.log(`✅ Successo! Generato ${OUTPUT_PATH} con ${sortedRounds.length} giornate di lega.`);
  } catch (err) {
    console.error(`❌ Errore durante il salvataggio del file JSON: ${err.message}`);
    process.exit(1);
  }
}

main();