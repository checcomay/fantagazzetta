# La penna del Martedì ⚽

"*La penna del Martedì*" è il quotidiano ufficiale della lega Fantamacrì. È un sito web statico ad alte prestazioni generato con Astro, progettato per raccontare la cronaca, i drammi e i trionfi di ogni fanta-giornata.

L'interfaccia si ispira all'eleganza delle storiche testate sportive, offrendo articoli dettagliati, pagelle della redazione, un archivio storico delle giornate precedenti e una dashboard laterale con le classifiche costantemente aggiornate.

## 🛠️ Come funziona il progetto

Il sito è costruito per separare completamente il codice dal contenuto editoriale:
- **Articoli:** Vengono scritti in formato Markdown (`.md`) all'interno della cartella `src/content/articles/`. Ogni file genera in automatico la sua pagina web dedicata e compare nella Home Page in ordine cronologico.
- **Classifiche:** I dati delle squadre sono gestiti tramite un semplice file `src/data/standings.json`. Modificando i punti in questo file, la tabella nella Home Page si aggiorna automaticamente, ricalcolando la Fanta Media (FM) ed evidenziando i picchi massimi e minimi. Il sito integra inoltre una **classifica dei giocatori**, alimentata dalle statistiche individuali, per monitorare i top player e le performance di tutta la lega.
- **Immagini e loghi:** Sono contenuti nella cartella `public/`. I loghi delle squadre vengono associati automaticamente al nome presente nel JSON della classifica.

## 🤖 Automazione con Makefile (metodo consigliato)

Per semplificare l'aggiornamento dei dati senza dover incollare lunghi percorsi nel terminale, il progetto sfrutta un `Makefile`. Assicurati di aver scaricato i file necessari nella cartella `~/Downloads` e usa questi comandi dalla root del progetto:

* **`make`**: Esegue in sequenza la creazione delle squadre, l'assegnazione delle statistiche e la lettura della classifica generale. Se manca un file, il terminale ti avviserà fornendoti il link per scaricarlo.
* **`make squads`**: Genera le rose aggiornate incrociando listone e CSV (utile post-mercato o scambi).
* **`make stats`**: Assegna le statistiche di rendimento ai singoli giocatori.
* **`make ranking`**: Aggiorna la classifica generale della lega.
* **`make clean-downloads`**: Per ripulire i file scaricati.
* **`make dev`**: Avvia il server di sviluppo locale.

## 📥 Esportare i dati e script manuali

Se non utilizzi il `Makefile` o hai bisogno di lanciare gli script singolarmente, ecco i dettagli sulle sorgenti dati e i comandi Node nativi.

### 🏆 1. Aggiornare la classifica ufficiale

Per aggiornare i dati del file `standings.json` o semplicemente per conservare uno storico ufficiale della lega.

1. Vai alla pagina ufficiale della classifica della lega Fantamacrì:
👉 **[Classifica Fantamacrì 26/27](https://leghe.fantacalcio.it/fantamacri-26-27/view/competition/384061/standings)**
2. Assicurati di aver effettuato l'accesso con le tue credenziali utente.
3. Una volta caricata la pagina con i dati aggiornati, scarica il file **Excel** ed esegui il seguente comando:

```bash
node scripts/ranking_reader.js ~/Downloads/Classifica_Campionato-2026-27.xlsx
```

### 📊 2. Aggiornare le statistiche dei giocatori

Dopo ogni giornata di Serie A, aggiorna le statistiche (gol, assist, xG, xA, ecc.) per alimentare la classifica giocatori. Tali modifiche sono memorizzate nel file `player_stats.json`.

1. Vai alla pagina ufficiale di Understat:
👉 **[Statistiche Serie A](https://understat.com/league/Serie_A)**
2. Vai in fondo alla pagina e scarica il file `.csv` dei giocatori.
3. Una volta scaricato il file, esegui il seguente comando:

```bash
node scripts/assign_player_stats.js ~/Downloads/league-players.csv
```

### ⚽️ 3. Creazione delle Squadre e dei Roster

Questo script legge il listone ufficiale e il file delle rose per creare un array piatto di tutti i giocatori acquistati, assegnandoli alle rispettive fanta-squadre (generando il file `squads.json`). Va eseguito ogni volta che avviene un movimento interno alla lega (come scambi o svincoli) oppure in seguito ad un'asta.

1. Vai alla pagina del listone Fantacalcio 2026/27 e scarica il file Excel:
👉 **[Listone Quotazioni Fantacalcio](https://www.fantacalcio.it/quotazioni-fantacalcio)**
2. Vai alla pagina dei rosters di ogni squadra del Fantamacrì e scarica il CSV:
👉 **[Fantamacrì Rosters](https://leghe.fantacalcio.it/fantamacri-26-27/view/rosters/)**
3. Esegui il seguente comando (Nota: se usi `make squads` il file più recente viene selezionato in automatico senza problemi di wildcard):

```bash
node scripts/create_squads.js ~/Downloads/Quotazioni_Fantacalcio_Stagione_2026_27.xlsx ~/Downloads/\'fantamacri-26-27_rosters_*.csv
```