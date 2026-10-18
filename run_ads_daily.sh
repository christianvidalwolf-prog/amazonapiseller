#!/bin/bash
# ==============================================================================
# Control diario de Amazon Ads (campañas profit-first "PF |", ES/DE/FR/IT) — 9:00
# launchd: ~/Library/LaunchAgents/com.christianvidalwolf.adsdaily.plist
#  1. Informes de Amazon Ads + stock/Buy Box (lunes: también márgenes)
#  2. Guardia de stock/Buy Box + regulador de ACoS por país (ads:daily)
#  3. Auditoría en 5 secciones (ads:audit)
#  Informe diario en PDF: informes-ads/AAAA-MM-DD.pdf · decisiones: informes-ads/decisiones.txt
# Todo en backend/data (ADS_STORE=file). Log: backend/data/logs/ads-daily.log
# ==============================================================================

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
BASE_DIR="/Users/christianvidalwolf/AMAZON AWS SP-API"
LOG_DIR="$BASE_DIR/backend/data/logs"
LOG_FILE="$LOG_DIR/ads-daily.log"
TODAY="$(date +%Y-%m-%d)"

mkdir -p "$LOG_DIR"
cd "$BASE_DIR/backend" || exit 1

notify() {
  osascript -e "display notification \"$1\" with title \"Amazon Ads\"" >/dev/null 2>&1 || true
}

{
  echo ""
  echo "======================================================================"
  echo "CONTROL DIARIO AMAZON ADS - $(date)"
  echo "======================================================================"
} >> "$LOG_FILE"

STEPS="reports,context"
if [ "$(date +%u)" = "1" ]; then STEPS="reports,margins,context"; fi

ADS_STORE=file ADS_SYNC_STEPS="$STEPS" ADS_SYNC_MAX_WAIT_MIN=60 npm run --silent ads:sync-reports >> "$LOG_FILE" 2>&1
SYNC_EXIT=$?

ADS_STORE=file npm run --silent ads:daily >> "$LOG_FILE" 2>&1
DAILY_EXIT=$?

ADS_STORE=file npm run --silent ads:audit > /dev/null 2>> "$LOG_FILE"

PDF="$BASE_DIR/informes-ads/$TODAY.pdf"
if [ "$SYNC_EXIT" -ne 0 ] || [ "$DAILY_EXIT" -ne 0 ]; then
  notify "Control diario con errores: revisa backend/data/logs/ads-daily.log"
elif tail -40 "$LOG_FILE" | grep -q "ALERTA_ACOS"; then
  notify "ACoS por encima del 25 % en algún país. Informe: informes-ads/$TODAY.pdf"
else
  notify "Informe diario listo: informes-ads/$TODAY.pdf"
fi
if tail -40 "$LOG_FILE" | grep -q "INFORME_30_DIAS_LISTO"; then
  notify "Informe de 30 días listo: informes-ads/informe-30-dias.pdf"
fi
[ -f "$PDF" ] || echo "[$(date)] aviso: no se generó el PDF $PDF" >> "$LOG_FILE"

echo "[$(date)] fin (sync=$SYNC_EXIT, daily=$DAILY_EXIT)" >> "$LOG_FILE"
