import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || import.meta.env.RESEND_API_KEY);

// Indirizzo mittente (puoi usare 'onboarding@resend.dev' per i test, oppure il tuo dominio verificato)
const SENDER_EMAIL = 'La Fantagazzetta <onboarding@resend.dev>';

export async function sendEmail({ to, subject, html }) {
  try {
    const data = await resend.emails.send({
      from: SENDER_EMAIL,
      to,
      subject,
      html
    });
    return { success: true, data };
  } catch (error) {
    console.error('Errore durante l\'invio email:', error);
    return { success: false, error };
  }
}