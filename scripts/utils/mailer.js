import nodemailer from 'nodemailer';

import 'dotenv/config'; 

const gmailUser = (typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.GMAIL_USER : null) 
  || process.env.GMAIL_USER;
  
const gmailPass = (typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.GMAIL_PASS : null) 
  || process.env.GMAIL_PASS;

if (!gmailUser || !gmailPass) {
  console.error("❌ Credenziali GMAIL mancanti nel file .env");
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: gmailUser,
    pass: gmailPass
  }
});

export async function sendEmail({ to, subject, html }) {
  try {
    const info = await transporter.sendMail({
      from: `"La Fantagazzetta" <${gmailUser}>`,
      to,
      subject,
      html
    });
    console.log(`📧 Email inviata con successo a ${to}`);
    return info;
  } catch (error) {
    console.error(`❌ Errore critico invio email a ${to}:`, error.message);
    throw error;
  }
}
