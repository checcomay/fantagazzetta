DOWNLOADS := $(HOME)/Downloads

# Estrazione parametri dal file di configurazione
LEAGUE_NAME     := $(shell node -p "require('./league.config.json').leagueName")
SITE_URL        := $(shell node -p "require('./league.config.json').siteUrl")
FANTACALCIO_URL := $(shell node -p "require('./league.config.json').links.fantacalcio")
FANTACULO_URL   := $(shell node -p "require('./league.config.json').links.fantaculo")

# File statici da scaricare
QUOTES_FILE   := $(DOWNLOADS)/Quotazioni_Fantacalcio_Stagione_2026_27.xlsx
STATS_FILE    := $(DOWNLOADS)/league-players.csv
RANKING_FILE  := $(DOWNLOADS)/Classifica_Campionato-2026-27.xlsx
CALENDAR_FILE := $(DOWNLOADS)/Calendario_Campionato-2026-27.xlsx

# Risolve dinamicamente il file più recente delle rose esportate
ROSTERS_FILE := $(shell ls -t $(DOWNLOADS)/\'fantamacri-26-27_rosters_*.csv 2>/dev/null | head -n 1)

.PHONY: all update-all info sync-readme squads stats ranking bets pre-match odds lineups xfm logos calendar dev build git clean-downloads

# Imposta update-all come target di default se digiti solo "make"
.DEFAULT_GOAL := update-all

info:
	@echo "=== Configurazione lega: $(LEAGUE_NAME) ==="
	@echo "Sito:        $(SITE_URL)"
	@echo "Leghe FG:    $(FANTACALCIO_URL)"
	@echo "Fantaculo:   $(FANTACULO_URL)"

# Target per rigenerare o sincronizzare i link nel README
sync-readme:
	@node scripts/sync-readme.js
	@echo "README.md aggiornato con i dati di $(LEAGUE_NAME)"

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
		echo "❌ Errore: File $(STATS_FILE) statistiche mancante."; \
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
	@if [ ! -f "$(CALENDAR_FILE)" ]; then \
		echo "❌ Errore: File calendario mancante in $(DOWNLOADS)."; \
		echo "👉 Scarica il file Excel da: https://leghe.fantacalcio.it/fantamacri-26-27/view/competition/384061/fixtures"; \
		exit 1; \
	fi
	node scripts/gen_calendar.js

# 5. Calcolo delle schedine giocate
bets:
	@echo "💰 Calcolo delle schedine ancora in corso..."	
	node scripts/evaluate_bets.js

# ==========================================
# 🎯 PIPELINE PRE-MATCH (QUOTE & TITOLARITÀ)
# ==========================================

# Esegue in cascata l'estrazione quote, scraping formazioni e calcolo xFM
pre-match: odds lineups xfm
	@echo "🎯 Pipeline pre-partita completata!"

# Chiamata unica per quote giocatori + portieri
odds:
	@echo "⚽🧤 Estrazione unificata quote giocatori e portieri (The Odds API)..."
	node scripts/fetch_all_odds.js

# Scraping probabili formazioni e ballottaggi da Fantacalcio.it
lineups:
	@echo "🌐 Scraping probabili formazioni da Fantacalcio.it..."
	node scripts/get_indices.js

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

# Target con messaggio di commit passato come variabile (default: "new release")
M ?= new release
git:
	git add -A
	git commit -m "$(M)"
	git push origin main

# Pulizia cartella Downloads
clean-downloads:
	@echo "🧹 Pulizia dei vecchi file CSV/XLSX in $(DOWNLOADS)..."
	rm -f $(DOWNLOADS)/\'fantamacri-26-27_rosters_*.csv
	rm -f $(DOWNLOADS)/league-players*.csv
	rm -f $(DOWNLOADS)/Classifica_Campionato*.xlsx
	rm -f $(DOWNLOADS)/Quotazioni_Fantacalcio*.xlsx
	rm -f $(DOWNLOADS)/Calendario_Campionato*.xlsx