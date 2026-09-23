#!/usr/bin/env python3
"""
Sincronización Automática Diaria de Stock y Precios con Amazon SP-API.

Lee el archivo diario generado a las 7:00 AM en /Users/christianvidalwolf/Stock/
(por ejemplo: STOCK AMZ 20260923.xlsm o STOCK AMZ.xlsm) y lo envía a Amazon España
mediante la Feeds API (JSON_LISTINGS_FEED) de forma masiva, rápida y robusta.

Uso:
    python3 sync_daily_stock_amz.py [--dry-run] [--file=/ruta/al/archivo.xlsm]
"""

import os
import sys
import glob
import time
import json
import argparse
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import List, Dict, Any, Optional, Tuple

import requests
import openpyxl

# Añadir directorio actual al path para importar auth
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

from auth import get_access_token, get_base_url

STOCK_DIR = "/Users/christianvidalwolf/Stock"
LOG_DIR = os.path.join(STOCK_DIR, "logs")
MARKETPLACE_ES = "A1RKKUPIHCS9HS"
DEFAULT_SELLER_ID = os.getenv("SP_API_SELLER_ID", "A3RY0L9OY3TPHI").strip()
BATCH_SIZE = 10000


def log(msg: str):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] {msg}"
    print(line, flush=True)


def find_latest_stock_file(custom_path: Optional[str] = None) -> str:
    """Encuentra el archivo de stock más reciente en la carpeta Stock."""
    if custom_path:
        if os.path.exists(custom_path):
            return custom_path
        raise FileNotFoundError(f"El archivo especificado no existe: {custom_path}")

    today_str = datetime.now().strftime("%Y%m%d")
    today_pattern = os.path.join(STOCK_DIR, f"*{today_str}*.xlsm")
    today_matches = glob.glob(today_pattern)

    # 1. Prioridad: Archivo con la fecha de hoy (ej: STOCK AMZ 20260923.xlsm)
    candidates = []
    for f in today_matches:
        base = os.path.basename(f).lower()
        if "stock" in base and "amz" in base and not base.startswith("~$"):
            candidates.append(f)

    if candidates:
        candidates.sort(key=os.path.getmtime, reverse=True)
        return candidates[0]

    # 2. Archivo general STOCK AMZ.xlsm
    stock_amz_xlsm = os.path.join(STOCK_DIR, "STOCK AMZ.xlsm")
    if os.path.exists(stock_amz_xlsm):
        return stock_amz_xlsm

    # 3. Buscar cualquier .xlsm reciente con stock y amz
    all_xlsm = glob.glob(os.path.join(STOCK_DIR, "*[sS][tT][oO][cC][kK]*[aA][mM][zZ]*.xlsm"))
    valid_xlsm = [f for f in all_xlsm if not os.path.basename(f).startswith("~$")]
    if valid_xlsm:
        valid_xlsm.sort(key=os.path.getmtime, reverse=True)
        return valid_xlsm[0]

    # 4. Fallback a .csv o .txt si no hay .xlsm
    for ext in ("STOCK AMZ.csv", "STOCK AMZ.txt"):
        fallback = os.path.join(STOCK_DIR, ext)
        if os.path.exists(fallback):
            return fallback

    raise FileNotFoundError(f"No se encontró ningún archivo de stock reciente en {STOCK_DIR}")


def parse_stock_file(file_path: str) -> List[Dict[str, Any]]:
    """Lee el archivo .xlsm (o .csv/.txt) y extrae SKU, cantidad, precio, min y max."""
    log(f"📖 Leyendo datos desde: {file_path}")
    is_excel = file_path.lower().endswith((".xlsm", ".xlsx"))

    items = []
    if is_excel:
        wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
        sheet_name = "Plantilla" if "Plantilla" in wb.sheetnames else wb.sheetnames[0]
        ws = wb[sheet_name]

        # Obtener cabeceras de atributos de la fila 4 (1-indexed en Excel, fila índice 4 = atributos técnicos)
        rows_iter = ws.iter_rows(values_only=True)
        header_rows = []
        for _ in range(5):
            try:
                header_rows.append(next(rows_iter))
            except StopIteration:
                break

        if len(header_rows) < 5:
            wb.close()
            raise ValueError(f"El archivo {file_path} no tiene las filas de cabecera estándar de Amazon.")

        attr_row = [str(c or "").strip() for c in header_rows[4]]

        # Detectar columnas por atributo técnico o nombre
        try:
            col_sku = attr_row.index("contribution_sku#1.value")
        except ValueError:
            col_sku = 3  # Valor estándar en plantilla Amazon ES

        try:
            col_qty = attr_row.index("fulfillment_availability#1.quantity")
        except ValueError:
            col_qty = 5

        price_indices = [i for i, a in enumerate(attr_row) if "our_price" in a and "audience=ALL" in a]
        col_price = price_indices[0] if price_indices else 9

        min_indices = [i for i, a in enumerate(attr_row) if "minimum_seller_allowed_price" in a and "audience=ALL" in a]
        col_min = min_indices[0] if min_indices else 11

        max_indices = [i for i, a in enumerate(attr_row) if "maximum_seller_allowed_price" in a and "audience=ALL" in a]
        col_max = max_indices[0] if max_indices else 12

        lead_indices = [i for i, a in enumerate(attr_row) if "lead_time_to_ship_max_days" in a]
        col_lead = lead_indices[0] if lead_indices else 6

        # Procesar filas de datos (a partir de la fila 6)
        row_num = 5
        for row in rows_iter:
            row_num += 1
            if len(row) <= col_sku or not row[col_sku]:
                continue

            sku = str(row[col_sku]).strip()
            # Ignorar fila de ejemplo de Amazon u observaciones
            if not sku or sku.upper() in ("ABC123", "SKU") or sku.startswith("#"):
                continue

            # Cantidad
            raw_qty = row[col_qty] if len(row) > col_qty else None
            qty = 0
            if raw_qty is not None and str(raw_qty).strip():
                try:
                    qty = int(float(str(raw_qty).replace(",", ".").strip()))
                except ValueError:
                    qty = 0

            # Precio
            raw_price = row[col_price] if len(row) > col_price else None
            price = None
            if raw_price is not None and str(raw_price).strip():
                try:
                    price = round(float(str(raw_price).replace(",", ".").strip()), 2)
                except ValueError:
                    pass

            # Precios min y max
            min_price = None
            if len(row) > col_min and row[col_min] is not None and str(row[col_min]).strip():
                try:
                    min_price = round(float(str(row[col_min]).replace(",", ".").strip()), 2)
                except ValueError:
                    pass

            max_price = None
            if len(row) > col_max and row[col_max] is not None and str(row[col_max]).strip():
                try:
                    max_price = round(float(str(row[col_max]).replace(",", ".").strip()), 2)
                except ValueError:
                    pass

            lead_time = 2
            if len(row) > col_lead and row[col_lead] is not None and str(row[col_lead]).strip():
                try:
                    lead_time = int(str(row[col_lead]).strip())
                except ValueError:
                    lead_time = 2

            items.append({
                "sku": sku,
                "quantity": qty,
                "price": price,
                "min_price": min_price,
                "max_price": max_price,
                "lead_time": lead_time,
            })

        wb.close()
    else:
        # Fallback para .csv / .txt tab-delimited
        import csv
        with open(file_path, "r", encoding="utf-8-sig", errors="replace") as f:
            sample = f.read(4096)
            f.seek(0)
            delimiter = "\t" if "\t" in sample else (";" if ";" in sample else ",")
            reader = csv.reader(f, delimiter=delimiter)

            for i, row in enumerate(reader):
                if i < 5 or not row:
                    continue
                sku = row[0].strip() if len(row) > 0 else ""
                if not sku or sku.upper() in ("ABC123", "SKU") or sku.startswith("#"):
                    continue

                raw_qty = row[2] if len(row) > 2 else "0"
                try:
                    qty = int(float(raw_qty.replace(",", ".").strip()))
                except ValueError:
                    qty = 0

                raw_price = row[6] if len(row) > 6 else ""
                price = None
                if raw_price:
                    try:
                        price = round(float(raw_price.replace(",", ".").strip()), 2)
                    except ValueError:
                        pass

                items.append({
                    "sku": sku,
                    "quantity": qty,
                    "price": price,
                    "min_price": None,
                    "max_price": None,
                    "lead_time": 2,
                })

    log(f"✅ {len(items):,} SKUs cargados correctamente.")
    with_stock = sum(1 for it in items if it["quantity"] > 0)
    zero_stock = sum(1 for it in items if it["quantity"] == 0)
    log(f"   📊 Con stock disponible (> 0): {with_stock:,} SKUs")
    log(f"   💤 Sin stock (agotados = 0):   {zero_stock:,} SKUs")
    return items


def build_feed_payload(seller_id: str, items: List[Dict[str, Any]], start_index: int = 1) -> Dict[str, Any]:
    """Construye un documento JSON_LISTINGS_FEED v2.0 para Amazon SP-API."""
    messages = []
    for idx, item in enumerate(items, start=start_index):
        attributes: Dict[str, Any] = {
            "fulfillment_availability": [
                {
                    "fulfillment_channel_code": "DEFAULT",
                    "quantity": int(item["quantity"]),
                    "lead_time_to_ship_max_days": int(item.get("lead_time") or 2),
                }
            ]
        }

        if item.get("price") is not None:
            offer: Dict[str, Any] = {
                "currency": "EUR",
                "marketplace_id": MARKETPLACE_ES,
                "our_price": [
                    {
                        "schedule": [
                            {
                                "value_with_tax": float(item["price"])
                            }
                        ]
                    }
                ],
            }

            if item.get("min_price") is not None:
                offer["minimum_seller_allowed_price"] = [
                    {
                        "schedule": [
                            {
                                "value_with_tax": float(item["min_price"])
                            }
                        ]
                    }
                ]

            if item.get("max_price") is not None:
                offer["maximum_seller_allowed_price"] = [
                    {
                        "schedule": [
                            {
                                "value_with_tax": float(item["max_price"])
                            }
                        ]
                    }
                ]

            attributes["purchasable_offer"] = [offer]

        messages.append({
            "messageId": idx,
            "sku": item["sku"],
            "operationType": "PARTIAL_UPDATE",
            "productType": "PRODUCT",
            "requirements": "LISTING_OFFER_ONLY",
            "attributes": attributes,
        })

    return {
        "header": {
            "sellerId": seller_id,
            "version": "2.0",
            "issueLocale": "es_ES",
        },
        "messages": messages,
    }


def submit_feed(seller_id: str, items_batch: List[Dict[str, Any]], batch_num: int, total_batches: int) -> str:
    """Crea documento de feed, sube el payload a S3 y emite createFeed."""
    token = get_access_token()
    base_url = get_base_url()

    payload = build_feed_payload(seller_id, items_batch)
    body_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    log(f"🚀 [Lote {batch_num}/{total_batches}] Creando feed document para {len(items_batch):,} SKUs...")

    # 1. Create feed document
    doc_res = requests.post(
        f"{base_url}/feeds/2021-06-30/documents",
        headers={"x-amz-access-token": token, "Content-Type": "application/json"},
        json={"contentType": "application/json; charset=UTF-8"},
        timeout=30,
    )
    if doc_res.status_code != 201:
        raise RuntimeError(f"Error al crear Feed Document ({doc_res.status_code}): {doc_res.text}")

    doc_data = doc_res.json()
    doc_id = doc_data["feedDocumentId"]
    upload_url = doc_data["url"]

    # 2. Upload JSON to presigned S3 URL
    log(f"   Subiendo {len(body_bytes) / 1024 / 1024:.2f} MB a Amazon S3...")
    put_res = requests.put(
        upload_url,
        headers={"Content-Type": "application/json; charset=UTF-8"},
        data=body_bytes,
        timeout=120,
    )
    if put_res.status_code != 200:
        raise RuntimeError(f"Error en S3 PUT upload ({put_res.status_code}): {put_res.text}")

    # 3. Create feed
    log(f"   Emitiendo createFeed (JSON_LISTINGS_FEED)...")
    feed_res = requests.post(
        f"{base_url}/feeds/2021-06-30/feeds",
        headers={"x-amz-access-token": token, "Content-Type": "application/json"},
        json={
            "feedType": "JSON_LISTINGS_FEED",
            "marketplaceIds": [MARKETPLACE_ES],
            "inputFeedDocumentId": doc_id,
        },
        timeout=30,
    )
    if feed_res.status_code != 202:
        raise RuntimeError(f"Error al registrar Feed ({feed_res.status_code}): {feed_res.text}")

    feed_id = feed_res.json()["feedId"]
    log(f"   ✅ Feed registrado con ID: {feed_id}")
    return feed_id


def poll_feed_status(feed_id: str, timeout_seconds: int = 600) -> Dict[str, Any]:
    """Monitoriza el estado del feed hasta que termine (DONE, FATAL o CANCELLED)."""
    base_url = get_base_url()
    start_time = time.time()
    log(f"⏳ Monitorizando Feed {feed_id}...")

    while time.time() - start_time < timeout_seconds:
        token = get_access_token()
        res = requests.get(
            f"{base_url}/feeds/2021-06-30/feeds/{feed_id}",
            headers={"x-amz-access-token": token},
            timeout=30,
        )
        if res.status_code == 200:
            data = res.json()
            status = data.get("processingStatus")
            log(f"   Feed {feed_id}: estado = {status}")

            if status in ("DONE", "FATAL", "CANCELLED"):
                return data
        else:
            log(f"   Aviso: getFeed devolvió HTTP {res.status_code}")

        time.sleep(20)

    log(f"   ⚠️ Tiempo de espera agotado ({timeout_seconds}s) para el feed {feed_id}. Amazon continuará procesándolo en background.")
    return {"feedId": feed_id, "processingStatus": "IN_PROGRESS"}


def run_sync(dry_run: bool = False, custom_file: Optional[str] = None):
    """Función principal del proceso de sincronización."""
    os.makedirs(LOG_DIR, exist_ok=True)
    log("=" * 70)
    log("INICIO DE SINCRONIZACIÓN DIARIA DE STOCK Y PRECIOS (AMAZON ESPAÑA)")
    log("=" * 70)

    # 1. Localizar archivo
    file_path = find_latest_stock_file(custom_file)
    mtime = datetime.fromtimestamp(os.path.getmtime(file_path)).strftime("%Y-%m-%d %H:%M:%S")
    file_size_mb = os.path.getsize(file_path) / (1024 * 1024)
    log(f"Archivo seleccionado: {file_path}")
    log(f"Fecha modificación:  {mtime} ({file_size_mb:.2f} MB)")

    # 2. Parsear SKUs
    items = parse_stock_file(file_path)
    if not items:
        log("❌ No se encontraron SKUs en el archivo. Cancelando sincronización.")
        return

    seller_id = DEFAULT_SELLER_ID
    log(f"Cuenta Vendedor (Seller ID): {seller_id}")
    log(f"Mercado Destino:              España ({MARKETPLACE_ES})")

    # 3. Dividir en lotes de hasta BATCH_SIZE (máx permitido por Amazon: 25.000)
    batches = [items[i:i + BATCH_SIZE] for i in range(0, len(items), BATCH_SIZE)]
    log(f"Total de lotes a enviar:      {len(batches)} lote(s) de hasta {BATCH_SIZE:,} SKUs")

    if dry_run:
        log("🔍 [MODO DRY-RUN ACTIVADO]: No se enviará nada a Amazon.")
        for b_idx, batch in enumerate(batches, 1):
            log(f"   Simulado Lote {b_idx}/{len(batches)} con {len(batch):,} SKUs.")
            sample = batch[0]
            log(f"   Muestra SKU {sample['sku']}: Qty={sample['quantity']}, Precio={sample['price']} EUR")
        log("✅ Simulación completada con éxito.")
        return

    # 4. Enviar lotes a Amazon
    submitted_feed_ids = []
    for b_idx, batch in enumerate(batches, 1):
        try:
            feed_id = submit_feed(seller_id, batch, b_idx, len(batches))
            submitted_feed_ids.append(feed_id)
            if b_idx < len(batches):
                time.sleep(5)  # Breve pausa entre feeds
        except Exception as e:
            log(f"❌ Error al enviar lote {b_idx}: {e}")

    # 5. Monitorizar primer feed si hay tiempo
    for feed_id in submitted_feed_ids:
        try:
            poll_feed_status(feed_id, timeout_seconds=120)
        except Exception as e:
            log(f"⚠️ Error al consultar estado del feed {feed_id}: {e}")

    log("=" * 70)
    log(f"SINCRONIZACIÓN FINALIZADA: {len(submitted_feed_ids)} feed(s) enviados a Amazon.")
    log("=" * 70)


def main():
    parser = argparse.ArgumentParser(description="Sincronizador diario de Stock y Precios para Amazon SP-API.")
    parser.add_argument("--dry-run", action="store_true", help="Simula el proceso sin enviar nada a Amazon")
    parser.add_argument("--file", type=str, help="Ruta manual al archivo de stock (.xlsm o .csv)")
    args = parser.parse_args()

    try:
        run_sync(dry_run=args.dry_run, custom_file=args.file)
    except Exception as e:
        log(f"💥 ERROR CRÍTICO: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
