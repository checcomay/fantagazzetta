import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_ANON_KEY
);

export const prerender = false; // Forza l'esecuzione dinamica come serverless function su Vercel

export async function POST({ request }) {
  try {
    const body = await request.json();
    const { email, ...altriDati } = body;

    if (!email || !email.includes('@')) {
      return new Response(JSON.stringify({ error: 'Email non valida' }), { status: 400 });
    }

    const { error } = await supabase
      .from('iscritti')
      .upsert({
        email: email.trim().toLowerCase(),
        dati_extra: altriDati || {}
      }, { onConflict: 'email' });

    if (error) throw error;

    return new Response(JSON.stringify({ message: 'Iscrizione completata con successo' }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}