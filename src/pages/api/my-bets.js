import { createClient } from '@supabase/supabase-js';
import { findMatch, checkPick } from '../../../scripts/utils/bet_evaluator.js';

const supabaseUrl = import.meta.env.SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = import.meta.env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export const prerender = false;

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
        const matchData = findMatch(teams[0], teams[1], b.giornata_lega, calendarData);
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