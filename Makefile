# Variabili dei percorsi
DOWNLOADS := ~/Downloads

# File statici
QUOTES_FILE  := $(DOWNLOADS)/Quotazioni_Fantacalcio_Stagione_2026_27.xlsx
STATS_FILE   := $(DOWNLOADS)/league-players.csv
RANKING_FILE := $(DOWNLOADS)/Classifica_Campionato-2026-27.xlsx

# Risolve il problema del file dinamico: prende sempre e solo il file più recente
ROSTERS_FILE := $(shell ls -t $(DOWNLOADS)/\'fantamacri-26-27_rosters_*.csv 2>/dev/null | head -n 1)

.PHONY: all update-all squads stats ranking dev build clean-downloads

# Imposta update-all come target di default se digiti solo "make"
.DEFAULT_GOAL := update-all

# Target principale: aggiorna tutto in sequenza
update-all: squads stats ranking
	@echo "✅ Tutti i dati della lega Fantamacrì sono stati aggiornati!"

# 1. Creazione squadre
squads:
	@echo "🔄 Generazione delle squadre in corso..."
	@if [ ! -f "$(QUOTES_FILE)" ]; then \
		echo "❌ Errore: File listone mancante."; \
		echo "👉 Scaricalo da: https://www.fantacalcio.it/quotazioni-fantacalcio"; \
		exit 1; \
	fi
	@if [ -z "$(ROSTERS_FILE)" ]; then \
		echo "❌ Errore: File rose mancante in $(DOWNLOADS)."; \
		echo "👉 Scaricalo da: https://leghe.fantacalcio.it/fantamacri-26-27/view/rosters/"; \
		exit 1; \
	fi
	node scripts/create_squads.js "$(QUOTES_FILE)" "$(ROSTERS_FILE)"

# 2. Aggiornamento statistiche
stats:
	@echo "📊 Assegnazione statistiche ai giocatori..."
	@if [ ! -f "$(STATS_FILE)" ]; then \
		echo "❌ Errore: File statistiche mancante."; \
		echo "👉 Scaricalo da: https://understat.com/league/Serie_A (in fondo alla pagina, CSV)"; \
		exit 1; \
	fi
	node scripts/assign_player_stats.js "$(STATS_FILE)"

# 3. Lettura classifica
ranking:
	@echo "🏆 Aggiornamento della classifica..."
	@if [ ! -f "$(RANKING_FILE)" ]; then \
		echo "❌ Errore: File classifica mancante."; \
		echo "👉 Scaricalo in Excel da: https://leghe.fantacalcio.it/fantamacri-26-27/view/competition/384061/standings"; \
		exit 1; \
	fi
	node scripts/ranking_reader.js "$(RANKING_FILE)"

# Comandi Astro
dev:
	npm run dev

build:
	npm run build

# Utility opzionale: pulisce la cartella Downloads dai vecchi file fanta
clean-downloads:
	@echo "🧹 Pulizia dei vecchi file CSV/XLSX in $(DOWNLOADS)..."
	rm -f $(DOWNLOADS)/\'fantamacri-26-27_rosters_*.csv
	rm -f $(DOWNLOADS)/league-players*.csv
	rm -f $(DOWNLOADS)/Classifica_Campionato*.xlsx
	rm -f $(DOWNLOADS)/Quotazioni_Fantacalcio*.xlsx