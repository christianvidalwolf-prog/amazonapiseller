#!/bin/bash
# Script para replicar productos DCI de España a DE e IT usando create_listings_eu.py

SCRIPT_DIR="/Users/christianvidalwolf/orca/amazonapiseller"
VARIANTES_DIR="/Users/christianvidalwolf/AMAZON AWS SP-API/backend/scripts/variantes"

cd "$SCRIPT_DIR"

# Crear archivo temporal con SKUs DCI
python3 << 'EOF'
import json
with open(f"{VARIANTES_DIR}/pilot_spec_dci.json") as f:
    spec = json.load(f)
skus = set()
for name, data in spec.items():
    if 'children' in data:
        for s in data['children'].keys():
            if 'DCI' in s:
                skus.add(s)
with open('/tmp/dci_skus_final.txt', 'w') as f:
    for s in sorted(skus):
        f.write(s + '\n')
print(f"Total SKUs DCI: {len(skus)}")
EOF

TOTAL=$(wc -l < /tmp/dci_skus_final.txt)
echo "Total SKUs a replicar: $TOTAL"

# Función para replicar a un marketplace
replicate_marketplace() {
    local mp=$1
    local mp_name=$2
    local log_file="replicate_${mp}_dci.log"
    
    echo "Replicando a $mp_name..."
    echo "Log: $log_file"
    
    # Procesar en lotes de 10 para evitar rate limits
    count=0
    processed=0
    while read -r sku; do
        if [ -z "$sku" ]; then
            continue
        fi
        
        count=$((count + 1))
        processed=$((processed + 1))
        
        python3 create_listings_eu.py --sku "$sku" --marketplaces "$mp" --dry-run >> "$log_file" 2>&1
        
        if [ $count -eq 10 ]; then
            echo "  Procesados: $processed/$TOTAL"
            count=0
            sleep 5
        fi
        
        sleep 0.5
    done < /tmp/dci_skus_final.txt
    
    echo "$mp_name: Replicación en dry-run completada. Ver $log_file"
}

# Replicar a DE
echo "================================================================================"
echo "REPLICACIÓN DE PRODUCTOS DCI A DE"
echo "================================================================================"
replicate_marketplace "DE" "Alemania"

# Replicar a IT
echo "================================================================================"
echo "REPLICACIÓN DE PRODUCTOS DCI A IT"
echo "================================================================================"
replicate_marketplace "IT" "Italia"

echo "================================================================================"
echo "REPLICACIÓN COMPLETADA"
echo "================================================================================"
