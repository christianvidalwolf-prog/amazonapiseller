#!/bin/bash
set -euo pipefail

BASE_DIR="/Users/christianvidalwolf/AMAZON AWS SP-API"
LOG_FILE="/Users/christianvidalwolf/Stock/logs/price_escalation_2684314CLM.log"
STATE_FILE="/Users/christianvidalwolf/Stock/price_escalation_2684314CLM.state"
SKU="2684314CLM"
TARGET="21.95"

mkdir -p "/Users/christianvidalwolf/Stock/logs"
cd "$BASE_DIR"

if [[ -f "$STATE_FILE" ]]; then
  current=$(tr -d '[:space:]' < "$STATE_FILE")
else
  current="13.95"
fi

next=$(CURRENT="$current" python3 - <<'PY'
from decimal import Decimal
import os
current = Decimal(os.environ["CURRENT"])
print(f"{min(current + Decimal('1.00'), Decimal('21.95')):.2f}")
PY
)

if [[ "$current" == "$TARGET" ]]; then
  echo "[$(date)] Objetivo alcanzado para $SKU: $TARGET EUR. No se realiza ningún cambio." >> "$LOG_FILE"
  exit 0
fi

echo "[$(date)] Subiendo $SKU de $current a $next EUR" >> "$LOG_FILE"
/usr/bin/python3 "$BASE_DIR/sync_prices_stock.py" --sku "$SKU" --precio "$next" --pais ES >> "$LOG_FILE" 2>&1
echo "$next" > "$STATE_FILE"
