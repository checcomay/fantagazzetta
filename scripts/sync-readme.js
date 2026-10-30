import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const configPath = path.join(rootDir, 'league.config.json');
const templatePath = path.join(rootDir, 'README.template.md');
const outputPath = path.join(rootDir, 'README.md');

if (!fs.existsSync(configPath)) {
  console.error(`❌ Errore: file ${configPath} non trovato.`);
  process.exit(1);
}

if (!fs.existsSync(templatePath)) {
  console.error(`❌ Errore: file ${templatePath} non trovato.`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
let content = fs.readFileSync(templatePath, 'utf-8');

const replacements = {
  '{{LEAGUE_NAME}}': config.leagueName,
  '{{SEASON}}': config.season,
  '{{SEASON_CODE}}': config.seasonCode || (config.season ? config.season.replace('/', '_') : ''),
  '{{SEASON_DASH}}': config.season ? config.season.replace('/', '-') : '',
  '{{LEAGUE_SLUG}}': config.leagueSlug || '',
  '{{SITE_URL}}': config.siteUrl || '',
  '{{STANDINGS_URL}}': config.links?.standings || config.links?.fantacalcio || '',
  '{{ROSTERS_URL}}': config.links?.rosters || '',
  '{{FIXTURES_URL}}': config.links?.fixtures || '',
  '{{FANTACULO_URL}}': config.links?.fantaculo || '',
  '{{UNDERSTAT_URL}}': config.links?.understat || '',
  '{{SPONSOR_NAME}}': config.sponsor?.name || '',
  '{{SPONSOR_URL}}': config.sponsor?.url || ''
};

for (const [key, value] of Object.entries(replacements)) {
  content = content.replaceAll(key, value || '');
}

fs.writeFileSync(outputPath, content, 'utf-8');
console.log('✅ README.md sincronizzato con successo da league.config.json');
