# 📋 Roadmap e Miglioramenti - Fantamacrì 26-27

Questo documento raccoglie le linee guida, le criticità tecniche attuali e le proposte di sviluppo per elevare ulteriormente il livello del sito web della lega Fantamacrì.

---

## 1. Risoluzione del "name mismatch" (Odds API vs JSON Locale)


### Il Problema
Quando lo script Node.js interroga *The Odds API* per estrarre le quote dei marcatori (Player Props), i nomi restituiti dai bookmaker internazionali non coincidono quasi mai con quelli presenti nel database locale della nostra lega (`squads.json`).
Esempi tipici includono differenze di formattazione, accenti mancanti o abbreviazioni di nome/cognome. 
Attualmente, un livello di confidenza basato solo sul *fuzzy matching* rischia di scartare giocatori importanti o di associare quote errate.

Ho notato in particolare un problema per il giocatore "Jacobo Ramon", che è stato erroneamente confuso con "Ramos", probabilmente per la somiglianza dei loro cognomi.

### Soluzioni Proposte
* **Dizionario di Alias (Mapping Manuale):** Creare un file di supporto `src/data/alias_map.json` che funga da "dizionario di traduzione" rigido per i casi più critici o per i top player della lega che subiscono sempre variazioni di naming.
* **Normalizzazione Preliminare delle Stringhe:** Prima di applicare l'algoritmo di similarità, ripulire le stringhe rimuovendo diacritici/accenti, convertendo tutto in minuscolo ed eliminando preparticelle o abbreviazioni superflue (es. *jr*, *dap*, ecc.).
* **Log di Controllo Settimanale:** Modificare lo script affinché generi un report in console con i giocatori non trovati, permettendoci di aggiornare l'alias map prima del rilascio del venerdì.

---

## 2. Raffinamento della Formula xFM (Expected Fanta Media)

### Il Problema
La stima attuale della Fanta Media attesa (`xFM`) è troppo rudimentale o basata su stime fisse.
Inoltre, c'è un abbassamento drastico e ingiustificato nei confronti dei giocatori che non partono titolari.
Per avere un reale vantaggio predittivo nella pagina `/odds`, dobbiamo tradurre le quote dei bookmaker (gol, assist, cartellini) in un impatto numerico coerente con il regolamento del fantacalcio.

### Soluzione proposta

* Si potrebbe pensare di assegnare un peso diverso a difensori e centrocampisti di prendere un giallo o di subire un autogol.
* Dare una certa importanza anche ai giocatori che non sono titolari secondo le statistiche, quindi fare meno affidamento ai ballottaggi.
* Inserire una logica di "miglior modulo", che vada a scegliere la migliore formazioni tra quelle presenti che permetta di scegliere la formazione o il modulo una maggiore probabilità di fare più punti.

---

## 3. Ulteriori Proposte e Miglioramenti Architetturali

### A. Automazione Totale tramite GitHub Actions:
* **Obiettivo:** Evitare di dover eseguire manualmente lo script Node.js sul Mac ogni venerdì.
* **Come fare:** Configurare una GitHub Action (`.github/workflows/update_odds.yml`) programmata con una regola cron (es. ogni venerdì alle 14:00) che esegue lo script, fa il commit automatico del file `daily_odds.json` modificato e scatena la build su Vercel.

### B. Gestione Intelligente della Cache API (Rate Limit)
* Dato che *The Odds API* ha un limite mensile di chiamate nel piano gratuito, lo script locale dovrebbe implementare un sistema di salvataggio temporaneo (file di log o cache locale) per evitare di sprecare richieste in fase di test e sviluppo dell'interfaccia grafica.

### C. Sezione "Head-to-Head" (Scontri Diretti di Giornata)
* Sfruttando i dati delle fanta-squadre e le probabilità aggregate, creare un widget nella home o nella pagina `/odds` che simula l'andamento degli scontri diretti del weekend in corso, evidenziando il match clou della giornata.

### D. Ottimizzazione UX Mobile per i Grafici
* A seguito dei recenti aggiustamenti sulle tabelle, monitorare il comportamento dei canvas di Chart.js su schermi con larghezza inferiore a 375px (es. iPhone SE) per assicurarsi che i tooltip non vengano troncati dai bordi dello schermo.