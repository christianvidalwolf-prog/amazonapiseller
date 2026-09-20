import csv
import sys
import time
import requests
from auth import get_access_token, get_base_url

# Marketplace ID de España (A1RKKUPIHCS9HS)
DEFAULT_MARKETPLACE_ID = "A1RKKUPIHCS9HS"

def fetch_fba_inventory(marketplace_id=DEFAULT_MARKETPLACE_ID):
    """
    Consulta todo el inventario FBA usando el endpoint /fba/inventory/v1/summaries,
    gestionando la paginación con nextToken hasta obtener todos los registros.
    """
    token = get_access_token()
    base_url = get_base_url()
    endpoint = f"{base_url}/fba/inventory/v1/summaries"

    headers = {
        "x-amz-access-token": token,
        "User-Agent": "SP-API-Client/1.0",
    }

    params = {
        "granularityType": "Marketplace",
        "granularityId": marketplace_id,
        "marketplaceIds": marketplace_id,
        "details": "true",
    }

    all_items = []
    page = 1

    print(f"📦 Consultando inventario FBA para Marketplace: {marketplace_id}...")

    while True:
        print(f"   Leyendo página {page} (productos acumulados: {len(all_items)})...")

        # Reintento con backoff en caso de 429 QuotaExceeded
        max_retries = 6
        backoff = 2
        for attempt in range(max_retries):
            response = requests.get(endpoint, headers=headers, params=params)
            if response.status_code == 200:
                break
            elif response.status_code == 429:
                print(f"   ⚠️ Límite de tasa alcanzado (429). Esperando {backoff}s para reintentar página {page}...")
                time.sleep(backoff)
                backoff = min(backoff * 2, 30)
            else:
                print(f"❌ Error al consultar inventario FBA (HTTP {response.status_code}):")
                print(response.text)
                sys.exit(1)
        else:
            print("❌ Excedido el número máximo de reintentos por límite de cuota.")
            sys.exit(1)

        data = response.json()
        payload = data.get("payload", {})
        summaries = payload.get("inventorySummaries", [])
        all_items.extend(summaries)

        # SP-API devuelve nextToken en la clave de primer nivel 'pagination'
        pagination = data.get("pagination", {})
        next_token = pagination.get("nextToken") or payload.get("nextToken")
        if next_token:
            params = {
                "granularityType": "Marketplace",
                "granularityId": marketplace_id,
                "marketplaceIds": marketplace_id,
                "details": "true",
                "nextToken": next_token,
            }
            page += 1
            # Pausa de cortesía para respetar la cuota de Amazon (máx 2 req/s)
            time.sleep(0.6)
        else:
            break

    print(f"\n✅ Total de SKUs/productos encontrados en FBA: {len(all_items)}")
    return all_items

def parse_inventory(summaries):
    """Parsea y limpia la respuesta de la API a una lista de diccionarios tabulares."""
    rows = []
    for item in summaries:
        sku = item.get("sellerSku", "")
        asin = item.get("asin", "")
        fnsku = item.get("fnSku", "")
        product_name = item.get("productName", "")
        total_qty = item.get("totalQuantity", 0)

        details = item.get("inventoryDetails", {})
        fulfillable = details.get("fulfillableQuantity", 0)
        unfulfillable = details.get("unfulfillableQuantity", {}).get("totalUnfulfillableQuantity", 0)

        inbound_working = details.get("inboundWorkingQuantity", 0)
        inbound_shipped = details.get("inboundShippedQuantity", 0)
        inbound_receiving = details.get("inboundReceivingQuantity", 0)
        total_inbound = inbound_working + inbound_shipped + inbound_receiving

        reserved = details.get("reservedQuantity", {})
        res_orders = reserved.get("pendingCustomerOrderQuantity", 0)
        res_transfers = reserved.get("pendingTransshipmentQuantity", 0)
        res_processing = reserved.get("fcProcessingQuantity", 0)
        total_reserved = reserved.get("totalReservedQuantity", 0)

        rows.append({
            "SKU": sku,
            "ASIN": asin,
            "FNSKU": fnsku,
            "Nombre": product_name,
            "Total": total_qty,
            "Disponible": fulfillable,
            "Reservado": total_reserved,
            "En camino (Inbound)": total_inbound,
            "No disponible": unfulfillable,
            "Res. Pedidos": res_orders,
            "Res. Transferencias": res_transfers,
        })
    return rows

def export_to_csv(rows, filename="inventario_fba.csv"):
    if not rows:
        print("⚠️ No hay datos para exportar a CSV.")
        return

    fieldnames = list(rows[0].keys())
    with open(filename, mode="w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=";")
        writer.writeheader()
        writer.writerows(rows)
    print(f"💾 Inventario guardado en archivo: {filename}")

def display_summary(rows):
    if not rows:
        print("No se encontraron registros de inventario.")
        return

    # Estadísticas globales
    total_unidades = sum(r["Total"] for r in rows)
    total_disponibles = sum(r["Disponible"] for r in rows)
    total_reservadas = sum(r["Reservado"] for r in rows)
    total_inbound = sum(r["En camino (Inbound)"] for r in rows)

    print("\n" + "="*80)
    print(f"📊 RESUMEN GENERAL FBA (Amazon.es)")
    print("="*80)
    print(f" • Total SKUs únicos:       {len(rows)}")
    print(f" • Unidades Disponibles:    {total_disponibles}")
    print(f" • Unidades Reservadas:     {total_reservadas}")
    print(f" • Unidades en camino:      {total_inbound}")
    print(f" • Total unidades FBA:      {total_unidades}")
    print("="*80)

    # Mostrar primeros 15 artículos como muestra
    print("\n📦 Muestra de productos (primeros 15):")
    header_fmt = "{:<20} {:<12} {:>8} {:>10} {:>10} {:>10}"
    print(header_fmt.format("SKU", "ASIN", "TOTAL", "DISPONIBLE", "RESERVADO", "EN CAMINO"))
    print("-" * 75)
    for r in rows[:15]:
        sku = r["SKU"][:19]
        asin = r["ASIN"][:10]
        print(header_fmt.format(
            sku, asin, r["Total"], r["Disponible"], r["Reservado"], r["En camino (Inbound)"]
        ))
    if len(rows) > 15:
        print(f"... y {len(rows) - 15} productos más (ver archivo inventario_fba.csv completo).")

if __name__ == "__main__":
    summaries = fetch_fba_inventory()
    rows = parse_inventory(summaries)
    
    # 1. Exportar inventario completo
    export_to_csv(rows, "inventario_fba.csv")
    
    # 2. Exportar inventario filtrado con stock > 0
    rows_con_stock = [r for r in rows if r["Total"] > 0]
    export_to_csv(rows_con_stock, "inventario_fba_con_stock.csv")
    
    # 3. Mostrar resumen en pantalla
    display_summary(rows)
    print(f"\n💡 Del total, {len(rows_con_stock)} SKUs tienen unidades físicas activas (>0).")
    print(f"   Archivo filtrado generado: inventario_fba_con_stock.csv")
