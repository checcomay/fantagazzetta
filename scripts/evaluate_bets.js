import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { sendEmail } from './utils/mailer.js';
import 'dotenv/config';

import { findMatch, checkPick } from './utils/bet_evaluator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const supabaseUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ============================================================================
// TEMPLATE EMAIL NOTIFICA
// ============================================================================
function buildBetResultEmail(bet, newCredits) {
  const isWon = bet.status === 'vinta';
  const headerColor = isWon ? '#27ae60' : '#e74c3c';
  const headerText = isWon ? '🎉 SCHEDINA VINCENTE!' : '❌ SCHEDINA PERDENTE';

// Recupera la giornata di lega, con fallback se non disponibile
  const giornataText = bet.giornata_lega 
    ? `(giornata ${bet.giornata_lega} di Fantalega)` 
    : '';
  
  const itemsHtml = bet.selections.map(s => {
    const emoji = s.status === 'vinta' ? '✅' : (s.status === 'persa' ? '❌' : '⏳');
    return `
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 10px 0; font-weight: bold; color: #111;">${s.match}</td>
        <td style="padding: 10px 0; text-align: center; color: #c0392b; font-weight: bold;">${s.pick}</td>
        <td style="padding: 10px 0; text-align: center; font-weight: bold;">${s.risultato_reale}</td>
        <td style="padding: 10px 0; text-align: right;">${emoji}</td>
      </tr>
    `;
  }).join('');

  const payout = isWon 
    ? `<div style="color: #27ae60; font-size: 1.1rem; font-weight: bold; margin-top: 15px;">Hai vinto ${bet.potenziale_vincita} crediti! 💰</div>`
    : `<div style="color: #e74c3c; font-size: 1.1rem; font-weight: bold; margin-top: 15px;">Peccato, la schedina non è vincente.</div>`;

  return `
    <div style="font-family: Arial, sans-serif; max-width: 580px; margin: 0 auto; color: #222; border: 1px solid #e0e0e0; border-radius: 8px; padding: 24px;">
      <h2 style="color: ${headerColor}; margin-top: 0; text-transform: uppercase; border-bottom: 2px solid ${headerColor}; padding-bottom: 10px;">
        ${headerText}
      </h2>
      <p>Ciao! La tua giocata <strong>#${bet.id.slice(0, 8)}</strong> ${giornataText} della Fantagazzetta è stata calcolata.</p>
      <div style="background: #f8f9fa; border: 1px solid #ccc; border-radius: 6px; padding: 16px; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
          <thead>
            <tr style="border-bottom: 2px solid #ddd; text-align: left; color: #777;">
              <th style="padding-bottom: 6px;">Incontro</th>
              <th style="padding-bottom: 6px; text-align: center;">Esito</th>
              <th style="padding-bottom: 6px; text-align: center;">Ris. reale</th>
              <th style="padding-bottom: 6px; text-align: right;">Stato</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #ddd; font-size: 0.95rem;">
          <div>Puntata: <strong>${bet.puntata} crediti</strong> (Quota: ${bet.moltiplicatore_totale})</div>
          ${payout}
        </div>
      </div>
      <p style="font-size: 0.85rem; color: #777;">
        Il tuo saldo crediti aggiornato è di: <strong>${newCredits} crediti</strong>.
      </p>
    </div>
  `;
}

// ============================================================================
// ESECUZIONE PRINCIPALE DELLO SCRIPT
// ============================================================================
async function main() {
  console.log('🔄 Avvio valutazione massiva schedine...');

  // Lettura dati calendario locale
  const calendarPath = path.resolve(__dirname, '../src/data/calendar.json');
  let calendarData;
  try {
    const content = await fs.readFile(calendarPath, 'utf-8');
    calendarData = JSON.parse(content);
  } catch (err) {
    console.error('❌ Errore lettura calendar.json:', err.message);
    process.exit(1);
  }

  try {
    const { data: users, error } = await supabase.from('iscritti').select('*');
    if (error) throw error;

    let schedineConcluse = 0;

    for (const user of users) {
      if (!user.bets || user.bets.length === 0) continue;

      let credits = Number(user.credits ?? 100);
      let userHasChanges = false;
      const emailsToSend = [];

      const updatedBets = user.bets.map(b => {
        // Ignora schedine già processate e pagate
        if ((b.status === 'vinta' || b.status === 'persa') && (b.status === 'persa' || b.pagata)) {
          return b;
        }

        let betHasLoss = false;
        let allWon = true;

        const checkedSelections = (b.selections || []).map(sel => {
          const teams = sel.match.split(' - ');
          const matchData = findMatch(teams[0], teams[1], b.giornata_lega, calendarData);
          const selStatus = checkPick(sel.pick, matchData);

          if (selStatus === 'persa') betHasLoss = true;
          if (selStatus !== 'vinta') allWon = false;

          return {
            ...sel,
            status: selStatus,
            risultato_reale: matchData?.played && matchData?.score ? matchData.score : 'Da disputare'
          };
        });

        let newBetStatus = b.status || 'in_corso';

        if (betHasLoss) {
          newBetStatus = 'persa';
        } else if (allWon && checkedSelections.length > 0) {
          newBetStatus = 'vinta';
          if (!b.pagata) {
            credits += Number(b.potenziale_vincita || 0);
            b.pagata = true;
            userHasChanges = true;
          }
        }

        // Se la schedina ha cambiato stato da in_corso a conclusa, la segnamo per l'email
        if (newBetStatus !== b.status && newBetStatus !== 'in_corso') {
          b.status = newBetStatus;
          userHasChanges = true;
          schedineConcluse++;
          
          emailsToSend.push({
            ...b,
            status: newBetStatus,
            selections: checkedSelections
          });
        }

        return { ...b, status: newBetStatus, selections: checkedSelections };
      });

      if (userHasChanges) {
        // Salva l'aggiornamento nel database
        await supabase
          .from('iscritti')
          .update({ credits: Number(credits.toFixed(2)), bets: updatedBets })
          .eq('email', user.email);

        console.log(`✅ Utente ${user.email}: aggiornato (Crediti: ${credits.toFixed(2)})`);

        // Invia email asincrone per ogni schedina conclusa
        for (const concludedBet of emailsToSend) {
          const htmlBody = buildBetResultEmail(concludedBet, Number(credits.toFixed(2)));
          await sendEmail({
            to: user.email,
            subject: concludedBet.status === 'vinta' 
              ? `✅ Hai vinto! Esito della schedina #${concludedBet.id.slice(0, 8)}`
              : `Esito della schedina #${concludedBet.id.slice(0, 8)} - La Fantagazzetta`,
            html: htmlBody
          });
        }
      }
    }

    console.log(`\n✅ Elaborazione completata! ${schedineConcluse} schedine calcolate e notificate.`);
    process.exit(0);

  } catch (err) {
    console.error('❌ Errore durante la valutazione delle schedine:', err.message);
    process.exit(1);
  }
}

main();