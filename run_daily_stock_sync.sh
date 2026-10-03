#!/bin/bash
# ==============================================================================
# Automatización diaria de subida de Stock y Precios a Amazon Europa (ES, DE, FR, IT - 9:00 AM)
# ==============================================================================

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
BASE_DIR="/Users/christianvidalwolf/AMAZON AWS SP-API"
PYTHON="$BASE_DIR/.venv/bin/python"
LOG_FILE="/Users/christianvidalwolf/Stock/logs/daily_upload_amz.log"

mkdir -p "/Users/christianvidalwolf/Stock/logs"

echo "" >> "$LOG_FILE"
echo "======================================================================" >> "$LOG_FILE"
echo "EJECUCIÓN PROGRAMADA DE LAS 9:00 AM - $(date)" >> "$LOG_FILE"
echo "======================================================================" >> "$LOG_FILE"

cd "$BASE_DIR" || exit 1

# Ejecutar script de sincronización general
"$PYTHON" "$BASE_DIR/sync_daily_stock_amz.py" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

# Aplicar reglas de precios fijos si existe fixed_prices.csv
if [ -f "$BASE_DIR/fixed_prices.csv" ]; then
    echo "[$(date)] 🔄 Aplicando precios fijos desde fixed_prices.csv..." >> "$LOG_FILE"
    "$PYTHON" "$BASE_DIR/sync_prices_stock.py" --csv="$BASE_DIR/fixed_prices.csv" >> "$LOG_FILE" 2>&1
fi

# ==============================================================================
# Sincronización diaria a Cdiscount Marketplace
# ==============================================================================
echo "[$(date)] 🚀 Iniciando sincronización diaria de Stock y Precios a Cdiscount..." >> "$LOG_FILE"
"$PYTHON" "$BASE_DIR/sync_daily_cdiscount_stock.py" >> "$LOG_FILE" 2>&1
CDISC_EXIT_CODE=$?

echo "[$(date)] 📦 Enviando cupo diario de nuevas fichas de producto a Cdiscount..." >> "$LOG_FILE"
"$PYTHON" "$BASE_DIR/push_all_product_sheets.py" --batch-limit 25 >> "$LOG_FILE" 2>&1

echo "[$(date)] 🔄 Sincronizando ventas de PrestaShop y Cdiscount..." >> "$LOG_FILE"
"$PYTHON" "$BASE_DIR/sync_external_sales.py" >> "$LOG_FILE" 2>&1

if [ $CDISC_EXIT_CODE -eq 0 ]; then
    echo "[$(date)] ✅ Subida a Cdiscount completada con éxito." >> "$LOG_FILE"
else
    echo "[$(date)] ⚠️ Advertencia en subida a Cdiscount (código $CDISC_EXIT_CODE)." >> "$LOG_FILE"
fi

if [ $EXIT_CODE -eq 0 ]; then
    echo "[$(date)] ✅ Subida a Amazon completada con éxito." >> "$LOG_FILE"
else
    echo "[$(date)] ❌ Error en la subida a Amazon (código $EXIT_CODE)." >> "$LOG_FILE"
fi

exit $EXIT_CODE
