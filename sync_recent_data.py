#!/usr/bin/env python3
"""
sync_recent_data.py
Sincronizador incremental en segundo plano para Amazon SP-API.
Soporta tres modos:
  --mode=inventory : Refresca inventario_fba.csv con los datos más recientes de SP-API.
  --mode=sales     : Solicita reporte de ventas de los últimos días y hace upsert en ventas_2026.csv.
  --mode=all       : Ejecuta ambos procesos.
"""

import os
import sys
import time
import gzip
import csv
import argparse
from datetime import datetime, timedelta
import requests
from auth import get_access_token, get_base_url

DEFAULT_MARKETPLACE_ID = "A1RKKUPIHCS9HS" # España

def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)

# ----------------------------------------------------------------------
# 1. SINCRONIZACIÓN DE INVENTARIO FBA
# ----------------------------------------------------------------------
def sync_inventory():
    log("Iniciando sincronización de inventario FBA...")
    token = get_access_token()
    base_url = get_base_url()
    endpoint = f"{base_url}/fba/inventory/v1/summaries"

    headers = {
        "x-amz-access-token": token,
        "User-Agent": "SP-API-Client/1.0",
    }

    params = {
        "granularityType": "Marketplace",
        "granularityId": DEFAULT_MARKETPLACE_ID,
        "marketplaceIds": DEFAULT_MARKETPLACE_ID,
        "details": "true",
    }

    all_items = []
    page = 1

    while True:
        max_retries = 5
        backoff = 2
        for _ in range(max_retries):
            res = requests.get(endpoint, headers=headers, params=params)
            if res.status_code == 200:
                break
            elif res.status_code == 429:
                log(f"   Rate limit (429) en inventario. Reintentando en {backoff}s...")
                time.sleep(backoff)
                backoff = min(backoff * 2, 20)
            else:
                log(f"Error HTTP {res.status_code} en inventario: {res.text}")
                return False
        else:
            log("Excedidos los reintentos en inventario.")
            return False

        data = res.json()
        payload = data.get("payload", {})
        summaries = payload.get("inventorySummaries", [])
        all_items.extend(summaries)

        pagination = data.get("pagination", {})
        next_token = pagination.get("nextToken") or payload.get("nextToken")
        if next_token:
            params["nextToken"] = next_token
            page += 1
            time.sleep(0.6)
        else:
            break

    # Parsear filas
    rows = []
    for item in all_items:
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

    # Guardar en archivo CSV completo y con stock
    csv_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "inventario_fba.csv")
    csv_stock_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "inventario_fba_con_stock.csv")

    fieldnames = list(rows[0].keys()) if rows else []
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=";")
        writer.writeheader()
        writer.writerows(rows)

    with open(csv_stock_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=";")
        writer.writeheader()
        writer.writerows([r for r in rows if r["Total"] > 0])

    log(f"✅ Inventario FBA sincronizado con éxito ({len(rows)} SKUs totales, {sum(r['Total'] for r in rows)} unidades).")
    return True

# ----------------------------------------------------------------------
# 2. SINCRONIZACIÓN DE VENTAS (ÚLTIMOS 15 DÍAS CON UPSERT)
# ----------------------------------------------------------------------
def sync_sales(days_back=15):
    log(f"Iniciando sincronización incremental de ventas (últimos {days_back} días)...")
    token = get_access_token()
    base_url = get_base_url()

    now = datetime.utcnow()
    start_dt = now - timedelta(days=days_back)
    start_time = start_dt.strftime("%Y-%m-%dT00:00:00Z")
    end_time = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    url_report = f"{base_url}/reports/2021-06-30/reports"
    payload = {
        "reportType": "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL",
        "marketplaceIds": [DEFAULT_MARKETPLACE_ID],
        "dataStartTime": start_time,
        "dataEndTime": end_time,
    }

    # Solicitar reporte
    for _ in range(5):
        res = requests.post(
            url_report,
            headers={"x-amz-access-token": token, "Content-Type": "application/json"},
            json=payload,
        )
        if res.status_code == 202:
            break
        elif res.status_code == 429:
            log("   Rate limit al solicitar reporte de ventas. Esperando 10s...")
            time.sleep(10)
        else:
            log(f"Error al solicitar reporte de ventas ({res.status_code}): {res.text}")
            return False
    else:
        return False

    report_id = res.json().get("reportId")
    log(f"   Reporte en cola (ID: {report_id}). Esperando generación...")

    # Esperar hasta DONE
    doc_id = None
    for attempt in range(40):
        time.sleep(4)
        status_res = requests.get(
            f"{base_url}/reports/2021-06-30/reports/{report_id}",
            headers={"x-amz-access-token": token},
        )
        if status_res.status_code != 200:
            continue
        data = status_res.json()
        status = data.get("processingStatus")
        if status == "DONE":
            doc_id = data.get("reportDocumentId")
            break
        elif status in ["FATAL", "CANCELLED"]:
            log(f"El reporte terminó con estado: {status}")
            return False
    else:
        log("Timeout esperando reporte de ventas de Amazon.")
        return False

    # Descargar documento
    doc_res = requests.get(
        f"{base_url}/reports/2021-06-30/documents/{doc_id}",
        headers={"x-amz-access-token": token},
    )
    doc_data = doc_res.json()
    download_url = doc_data.get("url")
    is_compressed = doc_data.get("compressionAlgorithm") == "GZIP"

    raw_data = requests.get(download_url).content
    if is_compressed:
        raw_data = gzip.decompress(raw_data)

    content_str = raw_data.decode("latin1", errors="replace")
    lines = content_str.splitlines()
    if len(lines) <= 1:
        log("Reporte sin registros nuevos.")
        return True

    reader = csv.DictReader(lines, delimiter="\t")
    new_rows = list(reader)
    log(f"   Líneas obtenidas en el periodo reciente: {len(new_rows)}")

    # Cargar ventas_2026.csv existentes y realizar Upsert
    csv_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ventas_2026.csv")
    existing_rows = []
    existing_fieldnames = []

    if os.path.exists(csv_path):
        with open(csv_path, "r", encoding="utf-8-sig") as f:
            r = csv.DictReader(f, delimiter=";")
            existing_fieldnames = r.fieldnames or []
            existing_rows = list(r)

    # Indexar por clave única: order_id + sku + (order-item-id si existe)
    def row_key(row):
        return f"{row.get('amazon-order-id', '')}|{row.get('sku', '')}|{row.get('order-item-id', '')}"

    merged_map = {}
    for r in existing_rows:
        merged_map[row_key(r)] = r

    updated_count = 0
    inserted_count = 0

    for nr in new_rows:
        key = row_key(nr)
        if key in merged_map:
            merged_map[key] = nr
            updated_count += 1
        else:
            merged_map[key] = nr
            inserted_count += 1

    merged_rows = list(merged_map.values())
    # Ordenar por fecha de compra descendente
    merged_rows.sort(key=lambda x: x.get("purchase-date", ""), reverse=True)

    fieldnames = existing_fieldnames if existing_fieldnames else list(new_rows[0].keys())

    # Escribir de vuelta a ventas_2026.csv
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=";", extrasaction="ignore")
        writer.writeheader()
        writer.writerows(merged_rows)

    log(f"✅ Ventas actualizadas: {inserted_count} nuevos pedidos, {updated_count} actualizados. Total histórico: {len(merged_rows)} líneas.")
    return True

# ----------------------------------------------------------------------
# PRINCIPAL
# ----------------------------------------------------------------------
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Amazon SP-API Background Data Sync")
    parser.add_argument("--mode", choices=["inventory", "sales", "all"], default="all", help="Qué sincronizar")
    parser.add_argument("--days", type=int, default=15, help="Días hacia atrás para sincronización de ventas")
    args = parser.parse_args()

    success = True
    if args.mode in ["inventory", "all"]:
        if not sync_inventory():
            success = False

    if args.mode in ["sales", "all"]:
        if not sync_sales(days_back=args.days):
            success = False

    if success:
        log("🎉 Sincronización finalizada con éxito.")
        sys.exit(0)
    else:
        log("⚠️ La sincronización finalizó con advertencias o errores.")
        sys.exit(1)
