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

.PHONY: all update-all info sync-readme squads stats ranking bets pre-match odds lineups xfm logos calendar dev build git clean-downloads help

# Imposta update-all come target di default se digiti solo "make"
.DEFAULT_GOAL := update-all

##@ 🔄 Pipeline Post-Giornata / Roster

update-all: stats ranking calendar bets ## [Default] Aggiorna stats, classifica, calendario e schedine
	@echo "✅ Tutti i dati della lega Fantamacrì sono stati aggiornati con successo!"

stats: ## Aggiorna statistiche giocatori da Understat
	@echo "📊 Assegnazione statistiche ai giocatori..."
	@if [ ! -f "$(STATS_FILE)" ]; then \
		echo "❌ Errore: File $(STATS_FILE) statistiche mancante."; \
		echo "👉 Scaricalo da: https://understat.com/league/Serie_A (in fondo alla pagina, CSV)"; \
		exit 1; \
	fi
	node scripts/assign_player_stats.js "$(STATS_FILE)"

ranking: ## Aggiorna la classifica ufficiale
	@echo "🏆 Aggiornamento della classifica..."
	@if [ ! -f "$(RANKING_FILE)" ]; then \
		echo "❌ Errore: File classifica mancante in $(DOWNLOADS)."; \
		echo "👉 Scarica il file Excel da: https://leghe.fantacalcio.it/fantamacri-26-27/view/competition/384061/standings"; \
		exit 1; \
	fi
	node scripts/ranking_reader.js "$(RANKING_FILE)"

calendar: ## Genera e aggiorna il calendario di lega
	@echo "🗓️ Aggiornamento calendario di lega..."
	@if [ ! -f "$(CALENDAR_FILE)" ]; then \
		echo "❌ Errore: File calendario mancante in $(DOWNLOADS)."; \
		echo "👉 Scarica il file Excel da: https://leghe.fantacalcio.it/fantamacri-26-27/view/competition/384061/fixtures"; \
		exit 1; \
	fi
	node scripts/gen_calendar.js

bets: ## Calcola le schedine ancora in corso
	@echo "💰 Calcolo delle schedine ancora in corso..."	
	node scripts/evaluate_bets.js

##@ 🎯 Pipeline Pre-Match (Quote & Titolarità)

pre-match: odds lineups xfm ## Esegue in cascata: odds, lineups, xfm
	@echo "🎯 Pipeline pre-partita completata!"

odds: ## Estrae quote giocatori e portieri (The Odds API)
	@echo "⚽🧤 Estrazione unificata quote giocatori e portieri (The Odds API)..."
	node scripts/fetch_all_odds.js

lineups: ## Scraping probabili formazioni da Fantacalcio.it
	@echo "🌐 Scraping probabili formazioni da Fantacalcio.it..."
	node scripts/get_indices.js

xfm: ## Calcola Expected Fantavoto (xFM) ponderato
	@echo "📈 Calcolo Expected Fantavoto (xFM) per tutte le fanta-squadre..."
	node scripts/calculate_xFM.js

##@ ⚙️  Configurazione & Utility

info: ## Mostra i parametri e i link della lega
	@echo "=== Configurazione lega: $(LEAGUE_NAME) ==="
	@echo "Sito:        $(SITE_URL)"
	@echo "Leghe FG:    $(FANTACALCIO_URL)"
	@echo "Fantaculo:   $(FANTACULO_URL)"

squads: ## Genera squadre e rose (da listone + CSV rose)
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

sync-readme: ## Sincronizza i link nel README.md
	@node scripts/sync-readme.js
	@echo "README.md aggiornato con i dati di $(LEAGUE_NAME)"

logos: ## Genera la palette colori dai loghi
	@echo "🎨 Generazione colori dai loghi..."
	node scripts/gen_team_colors.js

dev: ## Avvia il server di sviluppo Astro
	npm run dev

build: ## Compila il progetto Astro per la produzione
	npm run build

M ?= new release
git: ## Add, commit e push su main (usa M="messaggio")
	git add -A
	git commit -m "$(M)"
	git push origin main

clean-downloads: ## Rimuove i vecchi file CSV/XLSX da Downloads
	@echo "🧹 Pulizia dei vecchi file CSV/XLSX in $(DOWNLOADS)..."
	rm -f $(DOWNLOADS)/\'fantamacri-26-27_rosters_*.csv
	rm -f $(DOWNLOADS)/league-players*.csv
	rm -f $(DOWNLOADS)/Classifica_Campionato*.xlsx
	rm -f $(DOWNLOADS)/Quotazioni_Fantacalcio*.xlsx
	rm -f $(DOWNLOADS)/Calendario_Campionato*.xlsx

# Helper 
help:
	@printf "\n⚽ \033[1m$(LEAGUE_NAME) - Comandi disponibili\033[0m\n"
	@awk 'BEGIN {FS = ":.*##"} \
		/^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[33m%-18s\033[0m %s\n", $$1, $$2 } \
		/^##@/ { printf "\n\033[1;36m%s\033[0m\n", substr($$0, 5) } \
	' $(MAKEFILE_LIST)
	@printf "\n"
