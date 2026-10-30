import { createClient } from '@supabase/supabase-js';
import calendarData from '../../data/calendar.json';

const supabaseUrl = import.meta.env.SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = import.meta.env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export const prerender = false;

// Trova la partita nel calendario
function findMatch(home, away, targetRound = null) {
  const norm = (s) => (s || '').toLowerCase().trim();
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
function checkPick(pick, match) {
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
  if (hG === null || isNaN(hG) || aG === null || isNaN(aG)) return 'in_corso';

  const totGoals = hG + aG;
  const is1 = hG > aG;
  const isX = hG === aG;
  const is2 = hG < aG;
  const isGG = hG > 0 && aG > 0;

  // 1X2
  if (pick === '1') return is1 ? 'vinta' : 'persa';
  if (pick === 'X') return isX ? 'vinta' : 'persa';
  if (pick === '2') return is2 ? 'vinta' : 'persa';

  // Doppie Chance
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

  // Risultato Esatto
  if (pick.startsWith('Ris.')) {
    const target = pick.replace('Ris.', '').trim();
    return target === `${hG}-${aG}` ? 'vinta' : 'persa';
  }

  return 'in_corso';
}

export async function GET({ request }) {
  try {
    const url = new URL(request.url);
    const email = url.searchParams.get('email');

    if (!email) {
      return new Response(JSON.stringify({ error: 'Email richiesta' }), { status: 400 });
    }

    const cleanEmail = email.trim().toLowerCase();

    const { data: user, error } = await supabase
      .from('iscritti')
      .select('credits, bets')
      .eq('email', cleanEmail)
      .maybeSingle();

    if (error) throw error;

    let credits = user?.credits ?? 100;
    const bets = Array.isArray(user?.bets) ? user.bets : [];

    let hasChanges = false;

    // Elaborazione e verifica di ogni schedina
    const processedBets = bets.map(b => {

      // Se la schedina è già chiusa, non la ricalcoliamo
      if ((b.status === 'vinta' || b.status === 'persa') && (b.status === 'persa' || b.pagata)) {
        return b;
      }

      let betHasLoss = false;
      let allWon = true;

      const checkedSelections = (b.selections || []).map(sel => {
        const teams = sel.match.split(' - ');
        const matchData = findMatch(teams[0], teams[1], b.giornata_lega);
        const status = checkPick(sel.pick, matchData);

        if (status === 'persa') betHasLoss = true;
        if (status !== 'vinta') allWon = false;

        return {
          ...sel,
          status,
          risultato_reale: matchData?.played && matchData?.score 
            ? matchData.score 
            : 'Da disputare'
        };
      });

      let betStatus = b.status || 'in_corso';

      if (betHasLoss) {
        betStatus = 'persa';
      } else if (allWon && checkedSelections.length > 0) {
        betStatus = 'vinta';
        // Accredita vincita se non ancora riscossa
        if (!b.pagata) {
          credits += Number(b.potenziale_vincita || 0);
          b.pagata = true;
          hasChanges = true;
        }
      }

      if (betStatus !== b.status) {
        b.status = betStatus;
        hasChanges = true;
      }

      return {
        ...b,
        status: betStatus,
        selections: checkedSelections
      };
    });

    // Se sono cambiati gli stati o sono stati accreditati crediti, aggiorna Supabase
    if (hasChanges) {
      await supabase
        .from('iscritti')
        .update({ credits: credits, bets: processedBets })
        .eq('email', cleanEmail);
    }

    return new Response(JSON.stringify({
      credits: Number(credits.toFixed(2)),
      bets: processedBets.reverse() // Mostra prima le più recenti
    }), { status: 200 });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}