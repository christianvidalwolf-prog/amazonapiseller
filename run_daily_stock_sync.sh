#!/bin/bash
# ==============================================================================
# Automatización diaria de subida de Stock y Precios a Amazon España (9:00 AM)
# ==============================================================================

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
BASE_DIR="/Users/christianvidalwolf/AMAZON AWS SP-API"
PYTHON=/usr/bin/python3
LOG_FILE="/Users/christianvidalwolf/Stock/logs/daily_upload_amz.log"

mkdir -p "/Users/christianvidalwolf/Stock/logs"

echo "" >> "$LOG_FILE"
echo "======================================================================" >> "$LOG_FILE"
echo "EJECUCIÓN PROGRAMADA DE LAS 9:00 AM - $(date)" >> "$LOG_FILE"
echo "======================================================================" >> "$LOG_FILE"

cd "$BASE_DIR" || exit 1

# Ejecutar script de sincronización
$PYTHON "$BASE_DIR/sync_daily_stock_amz.py" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo "[$(date)] ✅ Subida a Amazon completada con éxito." >> "$LOG_FILE"
else
    echo "[$(date)] ❌ Error en la subida a Amazon (código $EXIT_CODE)." >> "$LOG_FILE"
fi

exit $EXIT_CODE
