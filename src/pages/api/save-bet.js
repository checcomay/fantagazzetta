import { createClient } from '@supabase/supabase-js'
import { sendEmail } from '../../../scripts/utils/mailer.js';

const supabaseUrl = import.meta.env.SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = import.meta.env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export const prerender = false;

export async function POST({ request }) {
  try {
    const { email, bet } = await request.json();

    if (!email || !email.includes('@') || !bet || !bet.selections || bet.selections.length === 0) {
      return new Response(JSON.stringify({ error: 'Dati incompleti o schedina vuota.' }), { status: 400 });
    }

    const cleanEmail = email.trim().toLowerCase();
    const stake = Number(bet.puntata) || 10;

    // Recupera l'utente
    const { data: userRecord, error: fetchError } = await supabase
      .from('iscritti')
      .select('credits, bets')
      .eq('email', cleanEmail)
      .maybeSingle();

    if (fetchError) throw fetchError;

    // Se l'utente non esiste, parte con 100 crediti
    let currentCredits = userRecord?.credits !== undefined && userRecord?.credits !== null 
      ? Number(userRecord.credits) 
      : 100;

    // Controllo disponibilità crediti
    if (currentCredits < stake) {
      return new Response(JSON.stringify({ 
        error: `Crediti insufficienti! Hai a disposizione solo ${currentCredits} crediti.` 
      }), { status: 400 });
    }

    // Decurta la puntata
    const newCredits = Number((currentCredits - stake).toFixed(2));
    const currentBets = Array.isArray(userRecord?.bets) ? userRecord.bets : [];

    const newBetEntry = {
      id: crypto.randomUUID(),
      data_giocata: new Date().toISOString(),
      puntata: stake,
      moltiplicatore_totale: bet.moltiplicatore_totale,
      potenziale_vincita: Number((stake * bet.moltiplicatore_totale).toFixed(2)),
      status: 'in_corso',
      pagata: false,
      selections: bet.selections
    };

    const updatedBets = [...currentBets, newBetEntry];

    // Salva nel database
    const { error: upsertError } = await supabase
      .from('iscritti')
      .upsert({
        email: cleanEmail,
        credits: newCredits,
        bets: updatedBets
      }, { onConflict: 'email' });

    if (upsertError) throw upsertError;

    // INVIO EMAIL
    const isFirstTime = !userRecord || (currentBets.length === 0);

    // Costruisci le righe HTML degli eventi giocati
    const itemsHtml = bet.selections.map(s => `
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 8px 0; font-weight: bold; color: #111;">${s.match}</td>
        <td style="padding: 8px 0; text-align: center; color: #c0392b; font-weight: bold;">${s.pick}</td>
        <td style="padding: 8px 0; text-align: right; color: #555;">${Number(s.odd).toFixed(2)}</td>
      </tr>
    `).join('');

    const welcomeBonusNotice = isFirstTime ? `
      <div style="background-color: #fcf8e3; border: 1px solid #fbeed5; color: #8a6d3b; padding: 12px; border-radius: 6px; margin-bottom: 20px;">
        🎉 <strong>Benvenuto nella Fantagazzetta!</strong> Ti abbiamo accreditato i tuoi <strong>100 crediti omaggio</strong> di benvenuto.
      </div>
    ` : '';

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #222; border: 1px solid #e0e0e0; border-radius: 8px; padding: 24px;">
        <h2 style="color: #111; margin-top: 0; text-transform: uppercase; border-bottom: 2px solid #111; padding-bottom: 10px;">
          La Fantagazzetta di Macrì
        </h2>
        ${welcomeBonusNotice}
        <p>La tua giocata è stata registrata con successo nel sistema.</p>
        
        <div style="background: #f8f9fa; border: 1px dashed #ccc; border-radius: 6px; padding: 16px; margin: 20px 0;">
          <h3 style="margin-top: 0; font-size: 1rem; color: #444;">RICEVUTA GIOCATA</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
            <thead>
              <tr style="border-bottom: 2px solid #ddd; text-align: left; color: #777;">
                <th style="padding-bottom: 6px;">Incontro</th>
                <th style="padding-bottom: 6px; text-align: center;">Esito</th>
                <th style="padding-bottom: 6px; text-align: right;">Quota</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
            </tbody>
          </table>
          
          <div style="margin-top: 15px; padding-top: 10px; border-top: 1px solid #ddd; font-size: 0.92rem;">
            <div>Puntata: <strong>${stake} crediti</strong></div>
            <div>Quota Totale: <strong>${bet.moltiplicatore_totale}</strong></div>
            <div style="color: #27ae60; font-size: 1.05rem; margin-top: 4px;">Potenziale vincita: <strong>${(stake * bet.moltiplicatore_totale).toFixed(2)} crediti</strong></div>
          </div>
        </div>

        <p style="font-size: 0.85rem; color: #777;">
          I tuoi crediti residui aggiornati sono: <strong>${newCredits}</strong>.<br/>
          Puoi controllare lo stato delle partite e le vincite in qualsiasi momento nella sezione pronostici.
        </p>
      </div>
    `;

    // Invio asincrono senza bloccare la risposta HTTP
    sendEmail({
      to: cleanEmail,
      subject: `🎟️ Ricevuta schedina #${newBetEntry.id.slice(0, 8)} - La Fantagazzetta di Macrì`,
      html: emailHtml
    });

    return new Response(JSON.stringify({ 
      message: 'Schedina giocata con successo!',
      newCredits: newCredits
    }), { status: 200 });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}