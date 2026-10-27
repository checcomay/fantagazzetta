# 📋 TODO List - Fantamacrì 26-27

> Registro operativo delle attività, refactoring e nuove feature per il sito della lega Fantamacrì.  
> **Target stack:** Node.js, Astro, Chart.js, Vercel, GitHub Actions.

---

## 🎯 Panoramica e Priorità

- [ ] **P0 - Critico / Bloccante**: Risoluzione disallineamento nomi giocatori (*Name Mismatch*)
- [ ] **P1 - Core Feature**: Revisione ed evoluzione modello `xFM` (Expected Fanta Media) & Ottimizzatore Modulo
- [ ] **P1 - DevOps / Infra**: Automazione pipeline settimanale via GitHub Actions
- [ ] **P2 - Ottimizzazione**: Caching e salvaguardia rate limit *The Odds API*
- [ ] **P2 - Frontend & Analytics**: Widget Head-to-Head (Scontri Diretti)
- [ ] **P3 - Polish & Mobile UX**: Adattamento responsive Chart.js (< 375px)

---

## 1. Data Matching: Risoluzione "Name Mismatch" (The Odds API ↔ squads.json)

- [ ] **1.1. Creazione file di mapping esplicito (`alias_map.json`)**
  - [ ] Creare `src/data/alias_map.json` per gestire conversioni deterministiche manuali.
  - [ ] Aggiungere mapping prioritario per fixare il falso positivo:
    - `"Jacobo Ramón"` / `"Jacobo Ramon"` ➔ `"Jacobo Ramón"` (prevenire mismatch con `"Sergio Ramos"` o simili).
  - [ ] Censire i top player soggetti a variazioni sistematiche tra bookmaker internazionali e archivio locale.

- [ ] **1.2. Pipeline di pre-processing e normalizzazione stringhe**
  - [ ] Implementare funzione di pulizia stringhe prima del matching:
    - Rimozione accenti e diacritici (`normalize("NFD").replace(/[\u0300-\u036f]/g, "")`).
    - Lowercase e rimozione caratteri speciali/punteggiatura.
    - Stripping prefissi/suffissi non rilevanti (es. `jr`, `sr`, `da`, `de`, `van`, ecc.).
  - [ ] Integrare logica a cascata: *Exact match* ➔ *Lookup in alias_map* ➔ *Fuzzy match normalizzato* con soglia di confidenza minima verificata.

- [ ] **1.3. Telemetria e reportistica pre-rilascio**
  - [ ] Aggiungere logging a fine esecuzione dello script Node.js:
    - Lista dei giocatori presenti nei feed quote ma non associati a nessun elemento di `squads.json`.
    - Warning specifici su match a bassa confidenza (< soglia tolleranza).
  - [ ] Stampare sommario aggregato in console (`matched: X`, `unmatched: Y`, `flagged: Z`) prima del rilascio del venerdì.

---

## 2. Algoritmo xFM & Logica di Formazione

- [ ] **2.1. Ponderazione dinamica per ruolo (Cartellini & Malus)**
  - [ ] Rimodulare l'impatto atteso di cartellini gialli/rossi in base al ruolo:
    - Maggior peso/probabilità statistica per Difensori (D) e Mediani/Centrocampisti (C).
  - [ ] Integrare rischio malus autogol differenziato per ruolo difensivo / portiere.

- [ ] **2.2. Gestione realistica del minutaggio e ballottaggi**
  - [ ] Eliminare il malus punitivo eccessivo per i non-titolari certi.
  - [ ] Introdurre un moltiplicatore basato sull'aspettativa di subentro (impatto da panchinaro ad alto potenziale di bonus).
  - [ ] Bilanciare le probabilità fornite dai bookmaker considerando la proiezione minuti effettivi in campo.

- [ ] **2.3. Motore "Miglior Modulo" (Best Lineup Optimizer)**
  - [ ] Implementare algoritmo di ottimizzazione per testare i moduli legali (es. 3-4-3, 3-5-2, 4-3-3, 4-4-2, 4-5-1, 5-3-2, ecc.).
  - [ ] Calcolare il punteggio `xFM` totale per combinazione modulo-titolari.
  - [ ] Evidenziare nella UI `/odds` il modulo matematicamente ottimale per massimizzare l'aspettativa di punteggio della rosa.

---

## 3. Automazione & CI/CD (GitHub Actions)

- [ ] **3.1. Workflow GitHub Actions schedulato**
  - [ ] Creare il file di configurazione workflow `.github/workflows/update_odds.yml`.
  - [ ] Configurare trigger cron settimanale (es. ogni venerdì alle 14:00 CET/CEST).
  - [ ] Configurare dispatch manuale (`workflow_dispatch`) per esecuzioni straordinarie (turni infrasettimanali, anticipi).

- [ ] **3.2. Script execution & Auto-commit**
  - [ ] Configurare job con setup Node.js, installazione dipendenze e secrets API (`ODDS_API_KEY`).
  - [ ] Eseguire lo script di fetching quote.
  - [ ] Verificare modifiche a `daily_odds.json`:
    - Eseguire `git commit` e `git push` automatico verso il branch di produzione.
    - Gestire il token GitHub con i permessi di scrittura (`contents: write`).
  - [ ] Verificare che il push scateni automaticamente la build e il deploy su Vercel.

---

## 4. Architettura Dati: Cache & Rate Limiting

- [ ] **4.1. File-based local cache per chiamate API**
  - [ ] Implementare uno strato di cache su file locale (es. `.cache/odds_cache.json` o file con timestamp TTL).
  - [ ] Bypassare la chiamata remota a *The Odds API* se la cache locale è valida (evitare consumo quota in fase di sviluppo/test locale UI).
  - [ ] Aggiungere flag CLI `--force-refresh` per forzare la chiamata remota solo quando necessario.

- [ ] **4.2. Monitoraggio quota residua**
  - [ ] Ispezionare gli header HTTP restituiti dall'API (`x-requests-remaining`, `x-requests-used`).
  - [ ] Tracciare e stampare a video il bilancio mensile residuo per prevenire l'esaurimento crediti.

---

## 5. Nuove Funzionalità UI / Analytics

- [ ] **5.1. Widget Head-to-Head (Scontri Diretti)**
  - [ ] Leggere il calendario di giornata e accoppiare le fanta-squadre.
  - [ ] Aggregare i valori `xFM` dei titolari per ogni scontro diretto.
  - [ ] Sviluppare componente grafico (Home o `/odds`) che mostri:
    - Probabilità di vittoria/pareggio/sconfitta per match.
    - Evidenziazione speciale del *Big Match* o match clou del turno.

---

## 6. Frontend & Mobile UX

- [ ] **6.1. Responsive Fix Canvas Chart.js**
  - [ ] Testare rendering dei grafici su viewport stretti (< 375px, es. iPhone SE).
  - [ ] Configurare opzioni tooltip di Chart.js per evitare clipping a bordo schermo:
    - `interaction: { mode: 'index', intersect: false }`
    - `plugins: { tooltip: { displayColors: false, position: 'nearest' } }`
    - Padding e font-size adattivi su breakpoint mobile.
  - [ ] Verificare contenimento dei canvas all'interno dei relativi wrapper con `overflow-x: auto` o `max-width: 100%`.


test per il push