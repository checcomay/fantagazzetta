# La penna del Martedì ⚽

"*La penna del Martedì*" è il quotidiano ufficiale della lega Fantamacrì. È un sito web statico ad alte prestazioni generato con Astro, progettato per raccontare la cronaca, i drammi e i trionfi di ogni fanta-giornata.

L'interfaccia si ispira all'eleganza delle storiche testate sportive, offrendo articoli dettagliati, pagelle della redazione, un archivio storico delle giornate precedenti, una dashboard laterale con le classifiche e una sezione predittiva pre-partita basata sulle quote dei bookmaker e sulle probabili formazioni.

## 🛠️ Come funziona il progetto

Il sito è costruito per separare completamente il codice dal contenuto editoriale e dai dati statistici:
- **Articoli:** Vengono scritti in formato Markdown (`.md`) all'interno della cartella `src/content/articles/`. Ogni file genera in automatico la sua pagina web dedicata e compare nella Home Page in ordine cronologico.
- **Classifiche e Rose:** I dati della lega sono tracciati in `src/data/standings.json` e `src/data/squads.json`. Modificando o ricreando questi file, la Home Page e le schede squadra si aggiornano in automatico.
- **Statistiche & Proiezioni (xFM):** Gli script in `scripts/` incrociano i dati di Understat, The Odds API e Fantacalcio.it per generare le metriche storiche e le proiezioni probabilistiche della giornata.
- **Immagini e loghi:** Sono contenuti nella cartella `public/`. I loghi delle squadre vengono associati automaticamente al nome presente nel JSON della classifica e i colori sociali sono sincronizzati da `team_colors.json`.

## 🤖 Automazione con Makefile (metodo consigliato)

Per semplificare l'aggiornamento dei dati senza dover incollare lunghi percorsi nel terminale, il progetto sfrutta un `Makefile`. Assicurati di aver scaricato i file necessari nella cartella `~/Downloads` e configurato il file `.env` per le API.

Usa questi comandi dalla root del progetto:

### Aggiornamento Dati Post-Giornata e Roster
- **`make`** (o **`make update-all`**): Esegue in sequenza la creazione delle squadre, l'assegnazione delle statistiche di rendimento e l'aggiornamento della classifica generale.
- **`make squads`**: Genera le rose aggiornate incrociando listone e CSV (da eseguire post-mercato o scambi).
- **`make stats`**: Assegna le statistiche stagionali individuali ai giocatori scaricate da Understat.
- **`make ranking`**: Aggiorna la classifica ufficiale della lega da file Excel.

### Pipeline Previsionale Giornata (Quote & Titolarità)
- **`make pre-match`**: Esegue in sequenza l'intera pipeline predittiva (quote giocatori, quote portieri, probabili formazioni e calcolo dell'Expected Fantavoto $xFM$).
- **`make odds-players`**: Scarica le quote dei giocatori di movimento (gol, doppiette, assist, cartellini) da The Odds API v4.
- **`make odds-gk`**: Calcola le probabilità di gol subiti (0, 1, 2, 3+) per i portieri tramite il mercato `team_totals`.
- **`make lineups`**: Effettua lo scraping delle percentuali di titolarità e ballottaggi da Fantacalcio.it.
- **`make xfm`**: Raccoglie tutti i dati precedenti e calcola l'Expected Fantavoto ($xFM$) per ogni giocatore raggruppato per fantasquadra.

### Utility e Configurazione
- **`make logos`**: Estrae la palette cromatica dai loghi delle squadre e salva `team_colors.json`.
- **`make calendar`**: Inserisce il calendario stagionale della lega in `calendar.json`.
- **`make clean-downloads`**: Rimuove i file XLSX/CSV temporanei scaricati in `~/Downloads`.
- **`make dev`**: Avvia il server locale di Astro.
- **`make build`**: Compila il sito statico per la produzione.

---

## 📥 Dettaglio script, tempistiche e sorgenti dati

### 🏆 1. Aggiornare la classifica ufficiale
- **Quando eseguirlo:** Il martedì mattina, alla chiusura ufficiale della giornata di Fantacalcio.
- **Sorgente:** [Classifica Fantamacrì 26/27](https://leghe.fantacalcio.it/fantamacri-26-27/view/competition/384061/standings) (scarica il file Excel).
- **Comando:**
```bash
node scripts/ranking_reader.js ~/Downloads/Classifica_Campionato-2026-27.xlsx
```

### 📊 2. Aggiornare le statistiche dei giocatori (Understat)

* **Quando eseguirlo:** Il martedì dopo la conclusione di tutte le partite del turno di Serie A.
* **Sorgente:** [Statistiche Serie A - Understat](https://understat.com/league/Serie_A) (in fondo alla tabella clicca "Download CSV").
* **Comando:**
```bash
node scripts/assign_player_stats.js ~/Downloads/league-players.csv
```

### ⚽ 3. Creazione delle Squadre e dei Roster

* **Quando eseguirlo:** Dopo le aste iniziali, sessioni di riparazione o scambi ufficializzati.
* **Sorgenti:**
1. [Listone Quotazioni Fantacalcio](https://www.fantacalcio.it/quotazioni-fantacalcio) (Excel).
2. [Rosters Fantamacrì](https://leghe.fantacalcio.it/fantamacri-26-27/view/rosters/) (CSV).

* **Comando:**
```bash
node scripts/create_squads.js ~/Downloads/Quotazioni_Fantacalcio_Stagione_2026_27.xlsx ~/Downloads/'fantamacri-26-27_rosters_*.csv'
```

### 🎯 4. Pipeline previsionale quote & titolarità (pre-match)

Questa suite prepara l'analisi della giornata in arrivo per consigliare chi schierare.

> ⚠️ **Tempistica consigliata:** Esegui questi comandi **tra il venerdì sera e il sabato mattina** (a poche ore dalla consegna delle formazioni). Eseguirli a inizio settimana genererebbe molti campi `null`, poiché i bookmaker quotano i Player Props e aprono le linee dettagliate solo a ridosso dei match.

1. **Quote giocatori di movimento (`scripts/fetch_odds.js`):**
Interroga *The Odds API v4* per i mercati `player_goal_scorer_anytime`, `player_goals` (doppietta Over 1.5), `player_assists`, `player_to_receive_card` e `player_to_receive_red_card`.
```bash
node scripts/fetch_odds.js
```
*Output:* `src/data/daily_odds.json`.

2. **Quote difesa e portieri (`scripts/fetch_gk.js`):**
Interroga il mercato `team_totals` delle squadre avversarie per calcolare le probabilità di subire 0 (Clean Sheet), 1, 2 o 3+ gol e il malus gol atteso.
```bash
node scripts/fetch_gk.js
```
*Output:* `src/data/daily_gk_odds.json`.

3. **Scraping % di titolarità (`scripts/get_indeces.js`):**
Estrae in tempo reale da [Fantacalcio.it - Probabili Formazioni](https://www.fantacalcio.it/probabili-formazioni-serie-a) le percentuali dei titolari e le quote dei ballottaggi per ogni giocatore in `squads.json`.
```bash
node scripts/get_indeces.js
```
*Output:* `src/data/prob_indeces.json`.

4. **Calcolo Expected Fantavoto ($xFM$) (`scripts/calculate_xFM.js`):**
Incrocia tutti i dati precedenti applicando il modello a base voto 6.0, ponderando i bonus/malus attesi (gol **+3**, doppietta **+3**, assist **+1**, giallo **-0.5**, rosso **-1**, autogol **-2**, clean sheet portiere **+1**) e la probabilità di voto dalla titolarità.
```bash
node scripts/calculate_xFM.js
```
*Output:* `src/data/xFMs.json`.

*Nota:* Con il comando **`make pre-match`** tutti e quattro i passaggi vengono eseguiti automaticamente in sequenza.

### 🏟️ 5. Modifica logo o colori squadra

* **Quando eseguirlo:** Se viene aggiornata l'immagine di un logo in `public/`.
* **Comando:**
```bash
node scripts/gen_team_colors.js
```
*Output:* `src/data/team_colors.json`.

### 🗓️ 6. Inserimento del calendario di lega

* **Quando eseguirlo:** Meglio farlo ogni gioranta, in modo che tiene conto del punteggio cumulativo della lega.
* **Sorgente:** [Calendario Fantamacrì](https://leghe.fantacalcio.it/fantamacri-26-27/view/competition/384061/fixtures).
* **Comando:**
```bash
node scripts/gen_calendar.js
```
*Output:* `src/data/calendar.json`.
