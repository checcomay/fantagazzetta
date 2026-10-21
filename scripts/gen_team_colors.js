import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOGOS_DIR = path.join(__dirname, '..', 'public', 'logos');
const OUTPUT_DIR = path.join(__dirname, '..', 'src', 'data');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'team_colors.json');

// Funzione di utilità per convertire i canali RGB in una stringa Hex
function rgbToHex(r, g, b) {
    return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1).toLowerCase();
}

async function extractColors() {
    try {
        if (!fs.existsSync(LOGOS_DIR)) {
            console.error(`❌ Errore: La cartella dei loghi non esiste in ${LOGOS_DIR}`);
            process.exit(1);
        }

        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }

        // Legge tutti i file nella directory
        const files = fs.readdirSync(LOGOS_DIR);
        const teamColors = {};

        for (const file of files) {
            // Filtra solo i file con estensioni immagine valide
            if (!/\.(png|jpe?g|webp|svg)$/i.test(file)) continue;

            const filePath = path.join(LOGOS_DIR, file);
            
            // Estrae il nome della squadra dal nome del file (es: "Ac Picchia.png" -> "Ac Picchia")
            const teamName = path.parse(file).name;

            // Sharp comprime l'immagine a 1 singolo pixel fondendo i colori
            // Ignoriamo l'alfa (trasparenza) e prendiamo solo i canali RGB
            // Corretto: assegna direttamente il Buffer alla variabile "data"
            const data = await sharp(filePath)
                .resize(1, 1, { fit: 'cover' })
                .ensureAlpha() 
                .raw()
                .toBuffer();

            const r = data[0];
            const g = data[1];
            const b = data[2];

            const hexColor = rgbToHex(r, g, b);
            teamColors[teamName] = hexColor;
            
            console.log(`🎨 Analizzato ${teamName} -> ${hexColor}`);
        }

        // Salvataggio nel file JSON con formattazione a 2 spazi
        fs.writeFileSync(OUTPUT_JSON, JSON.stringify(teamColors, null, 2), 'utf-8');
        console.log(`\n✅ Mappatura colori generata con successo in: ${OUTPUT_JSON}`);

    } catch (error) {
        console.error("❌ Si è verificato un errore durante l'estrazione:", error.message);
    }
}

extractColors();
