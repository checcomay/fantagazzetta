import fs from 'node:fs';
import path from 'node:path';

// Trova la partita nel calendario
export function findMatch(home, away, targetRound = null) {
  const norm = (s) => (s || '').toLowerCase().trim();

  // Lettura del file JSON tramite Node.js FS
  let calendarData = { rounds: [] };
  try {
    const calPath = path.resolve(process.cwd(), 'src/data/calendar.json');
    if (fs.existsSync(calPath)) {
      calendarData = JSON.parse(fs.readFileSync(calPath, 'utf-8'));
    }
  } catch (e) {
    console.error('Impossibile caricare calendar.json:', e.message);
  }

  for (const round of (calendarData.rounds || [])) {
    // Se la schedina ha una giornata salvata, controlliamo solo quella giornata!
    if (targetRound && round.round !== targetRound) 
      continue;
    for (const m of (round.matches || [])) {
      if (norm(m.home) === norm(home) && norm(m.away) === norm(away)) {
        return m;
      }
    }
  }
  return null;
}

// Valuta il singolo pronostico confrontando le quote con i gol di calendar.json
export function checkPick(pick, match) {
  if (!match || match.played !== true)
    return 'in_corso';

  let hG = null;
  let aG = null;

  // Estrae i gol direttamente dalla stringa "score" (es. "2-2")
  if (typeof match.score === 'string' && match.score.includes('-')) {
    const parts = match.score.split('-').map(s => Number(s.trim()));
    hG = parts[0];
    aG = parts[1];
  }

  // Se per qualche motivo il parsing fallisce, la diamo per in corso
  if (hG === null || isNaN(hG) || aG === null || isNaN(aG)) 
    return 'in_corso';

  const totGoals = hG + aG;
  const is1 = hG > aG;
  const isX = hG === aG;
  const is2 = hG < aG;
  const isGG = hG > 0 && aG > 0;

  // 1X2
  if (pick === '1') return is1 ? 'vinta' : 'persa';
  if (pick === 'X') return isX ? 'vinta' : 'persa';
  if (pick === '2') return is2 ? 'vinta' : 'persa';

  // Doppie chance
  if (pick === '1X') return (is1 || isX) ? 'vinta' : 'persa';
  if (pick === 'X2') return (isX || is2) ? 'vinta' : 'persa';
  if (pick === '12') return (is1 || is2) ? 'vinta' : 'persa';

  // Under / Over
  if (pick === 'U 1.5') return totGoals < 1.5 ? 'vinta' : 'persa';
  if (pick === 'O 1.5') return totGoals > 1.5 ? 'vinta' : 'persa';
  if (pick === 'U 2.5') return totGoals < 2.5 ? 'vinta' : 'persa';
  if (pick === 'O 2.5') return totGoals > 2.5 ? 'vinta' : 'persa';
  if (pick === 'U 3.5') return totGoals < 3.5 ? 'vinta' : 'persa';
  if (pick === 'O 3.5') return totGoals > 3.5 ? 'vinta' : 'persa';
  if (pick === 'U 4.5') return totGoals < 4.5 ? 'vinta' : 'persa';
  if (pick === 'O 4.5') return totGoals > 4.5 ? 'vinta' : 'persa';
  if (pick === 'U 5.5') return totGoals < 5.5 ? 'vinta' : 'persa';
  if (pick === 'O 5.5') return totGoals > 5.5 ? 'vinta' : 'persa';

  // Gol / No Gol
  if (pick === 'GG') return isGG ? 'vinta' : 'persa';
  if (pick === 'NG') return !isGG ? 'vinta' : 'persa';

  // Risultato esatto
  if (pick.startsWith('Ris.')) {
    const target = pick.replace('Ris.', '').trim();
    return target === `${hG}-${aG}` ? 'vinta' : 'persa';
  }

  return 'in_corso';
}