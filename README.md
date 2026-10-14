# La penna del Lunedì 📰⚽

"La penna del Lunedì" è il quotidiano ufficiale della lega Fantamacrì. È un sito web statico ad alte prestazioni generato con **Astro**, progettato per raccontare la cronaca, i drammi e i trionfi di ogni fanta-giornata. 

L'interfaccia si ispira all'eleganza delle storiche testate sportive, offrendo articoli dettagliati, pagelle della redazione, un archivio storico delle giornate precedenti e una dashboard laterale con la classifica costantemente aggiornata.

## 🛠️ Come funziona il progetto

Il sito è costruito per separare completamente il codice dal contenuto editoriale:
- **Articoli:** Vengono scritti in formato Markdown (`.md`) all'interno della cartella `src/content/articles/`. Ogni file genera in automatico la sua pagina web dedicata e compare nella Home Page in ordine cronologico.
- **Classifica:** I dati delle squadre sono gestiti tramite un semplice file `src/data/standings.json`. Modificando i punti in questo file, la tabella nella Home Page si aggiorna automaticamente, ricalcolando la Fanta Media (FM) ed evidenziando i picchi massimi e minimi.
- **Immagini e loghi:** Sono contenuti nella cartella `public/`. I loghi delle squadre vengono associati automaticamente al nome presente nel JSON della classifica.

## 🚀 Comandi rapidi (Node.js)

Per avviare il sito in locale durante la scrittura degli articoli:
```bash
npm run dev
```

Per generare la versione finale pronta per il caricamento su Vercel:

```bash
npm run build
```

---

## 📥 Esportare la classifica ufficiale in PDF

Per aggiornare i dati del file `standings.json` o semplicemente per conservare uno storico ufficiale della lega, puoi consultare o scaricare la classifica direttamente dalla piattaforma Fantacalcio.it.

1. Vai alla pagina ufficiale della classifica della lega Fantamacrì:
👉 **[Classifica Fantamacrì 26/27](https://leghe.fantacalcio.it/fantamacri-26-27/view/competition/384061/standings)**
2. Assicurati di aver effettuato l'accesso con le tue credenziali utente.
3. Una volta caricata la pagina con i dati aggiornati, puoi scaricare il PDF ed eseguire il seguente comando:
```bash
node scripts/ranking_reader.js ~/Downloads/Classifica_Campionato-2026-27.xlsx
```

---

## 📊 Aggiornare le statistiche dei giocatori

Dopo ogni giornata di Serie A, va eseguito il seguente comando per aggiornare le statistiche (gol, assist, xG, xA, ecc.) di ogni giocatore.
Tali modifiche sono memorizzate nel file `player_stats.json` e i passaggi da seguire sono i seguenti:

1. Vai alla pagina ufficiale di Understat:
👉 **[Statistiche Serie A](https://understat.com/league/Serie_A)**
2. Vai in fondo alla pagina e scarica il file `.csv` dei giocatori.
3. Una volta scaricato il file, esegui il seguente comando:
```bash
node scripts/assign_player_stats.js ~/Downloads/league-players.csv
```

---

## ⚽️ Creazione delle Squadre e dei Roster

Questo script legge il listone ufficiale e il file delle rose per creare un array piatto di tutti i giocatori acquistati, assegnandoli alle rispettive fanta-squadre.
Va eseguito ogni volta che avviene un movimento interno alla lega (come scambi o svincoli) oppure in seguito ad un'asta.

1. Vai alla pagina del listone Fantacalcio 2026/27:
👉 **[Listone Quotazioni Fantacalcio](https://www.fantacalcio.it/quotazioni-fantacalcio)**
2. Vai alla pagina dei rosters di ogni squadra del Fantamacrì:
👉 **[Fantamacrì Rosters](https://leghe.fantacalcio.it/fantamacri-26-27/view/rosters/)**
3. Eseguire il seguente comando:
```bash
node scripts/create_squads.js ~/Downloads/Quotazioni_Fantacalcio_Stagione_2026_27.xlsx ~/Downloads/\'fantamacri-26-27_rosters_*.csv
```
Viene generato il file `squads.json` che contiene i giocaotri per ogni fantasquadra.