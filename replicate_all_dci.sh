#!/bin/bash
# Replica TODOS los productos DCI de España a DE e IT

SCRIPT_DIR="/Users/christianvidalwolf/orca/amazonapiseller"
VARIANTES_DIR="/Users/christianvidalwolf/AMAZON AWS SP-API/backend/scripts/variantes"
LOG_DIR="$SCRIPT_DIR/logs_replicate"
mkdir -p "$LOG_DIR"

echo "================================================================================"
echo "INICIO DE REPLICACIÓN DE PRODUCTOS DCI A DE E IT"
echo "Fecha: $(date)"
echo "================================================================================"

# Crear archivo con todos los SKUs DCI
python3 << 'EOF'
import json
VARIANTES_DIR = "/Users/christianvidalwolf/AMAZON AWS SP-API/backend/scripts/variantes"
with open(f"{VARIANTES_DIR}/pilot_spec_dci.json") as f:
    spec = json.load(f)
skus = set()
for name, data in spec.items():
    if 'children' in data:
        for s in data['children'].keys():
            if 'DCI' in s:
                skus.add(s)
with open('/tmp/all_dci_skus.txt', 'w') as f:
    for s in sorted(skus):
        f.write(s + '\n')
print(f"Total SKUs DCI: {len(skus)}")
EOF

TOTAL=$(wc -l < /tmp/all_dci_skus.txt)
echo "Total SKUs DCI a replicar: $TOTAL"
echo ""

# Procesar en lotes de 50 para evitar rate limits
BATCH_SIZE=50
count=0
processed=0
failed_skus=0

while read -r sku; do
    if [ -z "$sku" ]; then
        continue
    fi
    
    count=$((count + 1))
    processed=$((processed + 1))
    
    # Replicar a DE
    echo "[$processed/$TOTAL] Replicando $sku a DE..."
    python3 create_listings_eu.py --sku "$sku" --marketplaces DE 2>&1 | grep -E "(creados|existían|❌)" | head -1
    
    # Sleep para rate limit
    if [ $count -eq $BATCH_SIZE ]; then
        echo "  Esperando para evitar rate limit..."
        sleep 30
        count=0
    fi
    
    sleep 0.5
done < /tmp/all_dci_skus.txt

echo ""
echo "================================================================================"
echo "REPLICACIÓN A DE COMPLETADA"
echo "================================================================================"
echo ""

# Replicar a IT
count=0
processed=0

while read -r sku; do
    if [ -z "$sku" ]; then
        continue
    fi
    
    count=$((count + 1))
    processed=$((processed + 1))
    
    # Replicar a IT
    echo "[$processed/$TOTAL] Replicando $sku a IT..."
    python3 create_listings_eu.py --sku "$sku" --marketplaces IT 2>&1 | grep -E "(creados|existían|❌)" | head -1
    
    # Sleep para rate limit
    if [ $count -eq $BATCH_SIZE ]; then
        echo "  Esperando para evitar rate limit..."
        sleep 30
        count=0
    fi
    
    sleep 0.5
done < /tmp/all_dci_skus.txt

echo ""
echo "================================================================================"
echo "REPLICACIÓN A IT COMPLETADA"
echo "================================================================================"
echo ""
echo "✅ TODOS LOS PRODUCTOS DCI HAN SIDO REPLICADOS A DE E IT"
echo "================================================================================"
