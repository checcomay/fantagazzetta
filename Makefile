DOWNLOADS := ~/Downloads

# File statici da scaricare
QUOTES_FILE  := $(DOWNLOADS)/Quotazioni_Fantacalcio_Stagione_2026_27.xlsx
STATS_FILE   := $(DOWNLOADS)/league-players.csv
RANKING_FILE := $(DOWNLOADS)/Classifica_Campionato-2026-27.xlsx

# Risolve dinamicamente il file più recente delle rose esportate
ROSTERS_FILE := $(shell ls -t $(DOWNLOADS)/\'fantamacri-26-27_rosters_*.csv 2>/dev/null | head -n 1)

.PHONY: all update-all squads stats ranking pre-match odds-players odds-gk lineups xfm logos calendar dev build clean-downloads

# Imposta update-all come target di default se digiti solo "make"
.DEFAULT_GOAL := update-all

# 1. Creazione squadre e rose
squads:
	@echo "🔄 Generazione delle squadre in corso..."
	@if [ ! -f "$(QUOTES_FILE)" ]; then \
		echo "❌ Errore: File listone mancante in $(DOWNLOADS)."; \
		echo "👉 Scaricalo da: https://www.fantacalcio.it/quotazioni-fantacalcio"; \
		exit 1; \
	fi
	@if [ -z "$(ROSTERS_FILE)" ]; then \
		echo "❌ Errore: File rose mancante in $(DOWNLOADS)."; \
		echo "👉 Scaricalo da: https://leghe.fantacalcio.it/fantamacri-26-27/view/rosters/"; \
		exit 1; \
	fi
	node scripts/create_squads.js "$(QUOTES_FILE)" "$(ROSTERS_FILE)"

# ==========================================
# 🔄 PIPELINE POST-GIORNATA / ROSTER
# ==========================================

# Aggiorna statistiche Understat, classifica e calendario in un solo colpo
update-all: stats ranking calendar
	@echo "✅ Tutti i dati della lega Fantamacrì sono stati aggiornati con successo!"

# 2. Aggiornamento statistiche Understat
stats:
	@echo "📊 Assegnazione statistiche ai giocatori..."
	@if [ ! -f "$(STATS_FILE)" ]; then \
		echo "❌ Errore: File statistiche mancante in $(DOWNLOADS)."; \
		echo "👉 Scaricalo da: https://understat.com/league/Serie_A (in fondo alla pagina, CSV)"; \
		exit 1; \
	fi
	node scripts/assign_player_stats.js "$(STATS_FILE)"

# 3. Lettura classifica ufficiale
ranking:
	@echo "🏆 Aggiornamento della classifica..."
	@if [ ! -f "$(RANKING_FILE)" ]; then \
		echo "❌ Errore: File classifica mancante in $(DOWNLOADS)."; \
		echo "👉 Scarica il file Excel da: https://leghe.fantacalcio.it/fantamacri-26-27/view/competition/384061/standings"; \
		exit 1; \
	fi
	node scripts/ranking_reader.js "$(RANKING_FILE)"

# 4. Generazione e aggiornamento del calendario della competizione
calendar:
	@echo "🗓️ Aggiornamento calendario di lega..."
	node scripts/gen_calendar.js

# ==========================================
# 🎯 PIPELINE PRE-MATCH (QUOTE & TITOLARITÀ)
# ==========================================

# Esegue in cascata l'estrazione quote, scraping formazioni e calcolo xFM
pre-match: odds-players odds-gk lineups xfm
	@echo "🎯 Pipeline pre-partita completata! File expected_fanta_stats.json pronto per Astro."

# Quote marcatori, doppiette, assist e cartellini
odds-players:
	@echo "⚽ Estrazione quote giocatori di movimento (The Odds API)..."
	node scripts/fetch_odds.js

# Quote gol subiti per i portieri (team_totals)
odds-gk:
	@echo "🧤 Estrazione quote gol subiti portieri (The Odds API)..."
	node scripts/fetch_gk.js

# Scraping probabili formazioni e ballottaggi da Fantacalcio.it
lineups:
	@echo "🌐 Scraping probabili formazioni da Fantacalcio.it..."
	node scripts/get_indeces.js

# Calcolo xFM (Expected Fantavoto) ponderato
xfm:
	@echo "📈 Calcolo Expected Fantavoto (xFM) per tutte le fanta-squadre..."
	node scripts/calculate_xFM.js

# ==========================================
# ⚙️ CONFIGURAZIONE & UTILITY
# ==========================================

# Generazione palette colori loghi
logos:
	@echo "🎨 Generazione colori dai loghi..."
	node scripts/gen_team_colors.js

# Comandi Astro
dev:
	npm run dev

build:
	npm run build

# Pulizia cartella Downloads
clean-downloads:
	@echo "🧹 Pulizia dei vecchi file CSV/XLSX in $(DOWNLOADS)..."
	rm -f $(DOWNLOADS)/\'fantamacri-26-27_rosters_*.csv
	rm -f $(DOWNLOADS)/league-players*.csv
	rm -f $(DOWNLOADS)/Classifica_Campionato*.xlsx
	rm -f $(DOWNLOADS)/Quotazioni_Fantacalcio*.xlsx
	rm -f $(DOWNLOADS)/Calendario_Campionato*.xlsx