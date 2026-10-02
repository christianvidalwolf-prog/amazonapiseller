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
MARKETPLACES = {
    "ES": {"id": "A1RKKUPIHCS9HS", "name": "España", "locale": "es_ES", "flag": "🇪🇸", "price_offset": 0.0},
    "DE": {"id": "A1PA6795UKMFR9", "name": "Alemania", "locale": "de_DE", "flag": "🇩🇪", "price_offset": 5.0},
    "FR": {"id": "A13V1IB3VIYZZH", "name": "Francia", "locale": "fr_FR", "flag": "🇫🇷", "price_offset": 6.0},
    "IT": {"id": "APJ6JRA9NG5V4", "name": "Italia", "locale": "it_IT", "flag": "🇮🇹", "price_offset": 7.0},
}
DEFAULT_SELLER_ID = os.getenv("SP_API_SELLER_ID", "A3RY0L9OY3TPHI").strip()
BATCH_SIZE = 10000
SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()


def resolve_marketplaces(input_str: Optional[str]) -> List[str]:
    """Devuelve la lista de códigos de marketplace válidos (ej: ['ES', 'DE', 'FR', 'IT'])."""
    if not input_str or input_str.strip().upper() in ("ALL", "TODOS", "EU"):
        return ["ES", "DE", "FR", "IT"]

    codes = [c.strip().upper() for c in input_str.split(",") if c.strip()]
    valid = []
    for c in codes:
        if c in MARKETPLACES:
            valid.append(c)
        else:
            for k, v in MARKETPLACES.items():
                if v["id"] == c:
                    valid.append(k)
    return valid or ["ES", "DE", "FR", "IT"]


def log(msg: str):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] {msg}"
    print(line, flush=True)


def publish_stock_snapshot(file_path: str, items: List[Dict[str, Any]]) -> None:
    """Guarda la última copia de stock en Supabase, dividida en snapshots manejables."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        log("⚠️ Supabase no configurado; se conserva únicamente la copia local de stock.")
        return

    stamp = datetime.now().astimezone().isoformat()
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    url = f"{SUPABASE_URL}/rest/v1/snapshots?on_conflict=key"
    snapshot_size = 500
    chunks = [items[i:i + snapshot_size] for i in range(0, len(items), snapshot_size)]
    for idx, chunk in enumerate(chunks):
        payload = {
            "key": f"stock:latest:{idx:04d}",
            "data": {"sourceFile": os.path.basename(file_path), "updatedAt": stamp, "items": chunk},
            "updated_at": stamp,
        }
        response = requests.post(url, headers=headers, json=payload, timeout=60)
        response.raise_for_status()

    metadata = {
        "sourceFile": os.path.basename(file_path),
        "sourcePath": file_path,
        "updatedAt": stamp,
        "itemCount": len(items),
        "chunkSize": snapshot_size,
        "chunkCount": len(chunks),
    }
    response = requests.post(
        url,
        headers=headers,
        json={"key": "stock:latest:meta", "data": metadata, "updated_at": stamp},
        timeout=60,
    )
    response.raise_for_status()
    log(f"☁️ Última copia de stock guardada en Supabase ({len(items):,} SKU en {len(chunks)} bloques).")


# Mínimos por SKU y país de la regla FBM ≥ FBA × 1,05 (los calcula y publica cada noche
# backend/scripts/enforce-fbm-floor.ts en Supabase, clave rules:fbm-floor:prices).
FBM_FLOORS: Dict[str, Dict[str, float]] = {}
FBM_FLOOR_MAX_AGE_DAYS = 8


def load_fbm_floors() -> None:
    """Carga los mínimos de la regla FBM desde Supabase; sin ellos se envían los precios del fichero."""
    global FBM_FLOORS
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return
    try:
        res = requests.get(
            f"{SUPABASE_URL}/rest/v1/snapshots",
            params={"key": "eq.rules:fbm-floor:prices", "select": "data"},
            headers={"apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}"},
            timeout=60,
        )
        res.raise_for_status()
        rows = res.json()
        if not rows:
            log("⚠️ Sin mínimos de la regla FBM en Supabase; se usan los precios del fichero.")
            return
        data = rows[0]["data"]
        updated = datetime.fromisoformat(data["updatedAt"].replace("Z", "+00:00"))
        age_days = (datetime.now(updated.tzinfo) - updated).days
        if age_days > FBM_FLOOR_MAX_AGE_DAYS:
            log(f"⚠️ Mínimos de la regla FBM de hace {age_days} días; se ignoran.")
            return
        FBM_FLOORS = data.get("prices", {})
        log(f"📐 Regla FBM ≥ FBA × 1,05: mínimos cargados para {len(FBM_FLOORS):,} SKU.")
    except Exception as e:
        log(f"⚠️ No se pudieron cargar los mínimos de la regla FBM: {e}")


def apply_fbm_floor(sku: str, marketplace_code: str, price: float, max_price: float) -> Tuple[float, float]:
    """Sube el precio al mínimo de la regla FBM si queda por debajo (y el máximo, si hace falta)."""
    floor = FBM_FLOORS.get(sku, {}).get(marketplace_code)
    if floor is None or price >= floor:
        return price, max_price
    return round(float(floor), 2), max(max_price, round(float(floor) * 2, 2))


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

            if price is not None:
                if min_price is None:
                    min_price = round(price * 0.5, 2)
                if max_price is None:
                    max_price = round(price * 2.0, 2)

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

                raw_min = row[8] if len(row) > 8 else ""
                min_price = None
                if raw_min:
                    try:
                        min_price = round(float(raw_min.replace(",", ".").strip()), 2)
                    except ValueError:
                        pass

                raw_max = row[9] if len(row) > 9 else ""
                max_price = None
                if raw_max:
                    try:
                        max_price = round(float(raw_max.replace(",", ".").strip()), 2)
                    except ValueError:
                        pass

                if price is not None:
                    if min_price is None:
                        min_price = round(price * 0.5, 2)
                    if max_price is None:
                        max_price = round(price * 2.0, 2)

                items.append({
                    "sku": sku,
                    "quantity": qty,
                    "price": price,
                    "min_price": min_price,
                    "max_price": max_price,
                    "lead_time": 2,
                })

    log(f"✅ {len(items):,} SKUs cargados correctamente.")
    with_stock = sum(1 for it in items if it["quantity"] > 0)
    zero_stock = sum(1 for it in items if it["quantity"] == 0)
    log(f"   📊 Con stock disponible (> 0): {with_stock:,} SKUs")
    log(f"   💤 Sin stock (agotados = 0):   {zero_stock:,} SKUs")
    return items


def build_feed_payload(seller_id: str, items: List[Dict[str, Any]], marketplace_code: str = "ES", start_index: int = 1) -> Dict[str, Any]:
    """Construye un documento JSON_LISTINGS_FEED v2.0 para un marketplace específico."""
    mkt = MARKETPLACES.get(marketplace_code, MARKETPLACES["ES"])
    marketplace_id = mkt["id"]
    issue_locale = mkt["locale"]

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
            # Precio base (España) + incremento específico por marketplace FBM:
            # Alemania: +5.00 EUR | Francia: +6.00 EUR | Italia: +7.00 EUR | España: +0.00 EUR
            offset = float(mkt.get("price_offset", 0.0))
            base_p = float(item["price"])
            p = round(base_p + offset, 2)

            min_p = float(item["min_price"]) if item.get("min_price") is not None else round(base_p * 0.5, 2)
            min_p = round(min_p + offset, 2)
            max_p = float(item["max_price"]) if item.get("max_price") is not None else round(base_p * 2.0, 2)
            max_p = round(max_p + offset, 2)
            p, max_p = apply_fbm_floor(item["sku"], marketplace_code, p, max_p)

            offer: Dict[str, Any] = {
                "currency": "EUR",
                "marketplace_id": marketplace_id,
                "audience": "ALL",
                "our_price": [
                    {
                        "schedule": [
                            {
                                "value_with_tax": p
                            }
                        ]
                    }
                ],
                "minimum_seller_allowed_price": [
                    {
                        "schedule": [
                            {
                                "value_with_tax": min_p
                            }
                        ]
                    }
                ],
                "maximum_seller_allowed_price": [
                    {
                        "schedule": [
                            {
                                "value_with_tax": max_p
                            }
                        ]
                    }
                ],
                "discounted_price": [
                    {
                        "schedule": [
                            {
                                "start_at": "2026-01-01",
                                "end_at": "2026-01-02",
                                "value_with_tax": p,
                            }
                        ]
                    }
                ],
            }

            attributes["purchasable_offer"] = [offer]

        messages.append({
            "messageId": idx,
            "sku": item["sku"],
            "operationType": "PARTIAL_UPDATE",
            "productType": "PRODUCT",
            "attributes": attributes,
        })

    return {
        "header": {
            "sellerId": seller_id,
            "version": "2.0",
            "issueLocale": issue_locale,
        },
        "messages": messages,
    }


def submit_feed(seller_id: str, items_batch: List[Dict[str, Any]], marketplace_code: str, batch_num: int, total_batches: int) -> str:
    """Crea documento de feed, sube el payload a S3 y emite createFeed para el mercado indicado."""
    mkt = MARKETPLACES.get(marketplace_code, MARKETPLACES["ES"])
    marketplace_id = mkt["id"]

    token = get_access_token()
    base_url = get_base_url()

    payload = build_feed_payload(seller_id, items_batch, marketplace_code=marketplace_code)
    body_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    log(f"🚀 [{mkt['flag']} {marketplace_code} Lote {batch_num}/{total_batches}] Creando feed document para {len(items_batch):,} SKUs...")

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

    # 3. Create feed con reintentos para manejar límites de cuota (429 QuotaExceeded)
    log(f"   Emitiendo createFeed (JSON_LISTINGS_FEED para {mkt['name']})...")
    feed_id = None
    for attempt in range(1, 6):
        feed_res = requests.post(
            f"{base_url}/feeds/2021-06-30/feeds",
            headers={"x-amz-access-token": token, "Content-Type": "application/json"},
            json={
                "feedType": "JSON_LISTINGS_FEED",
                "marketplaceIds": [marketplace_id],
                "inputFeedDocumentId": doc_id,
            },
            timeout=30,
        )
        if feed_res.status_code == 202:
            feed_id = feed_res.json()["feedId"]
            log(f"   ✅ Feed registrado con ID: {feed_id} [{mkt['flag']} {marketplace_code}]")
            return feed_id
        elif feed_res.status_code == 429:
            wait_time = attempt * 30  # 30s, 60s, 90s, 120s, 150s
            log(f"   ⚠️ Límite de cuota alcanzado (429 QuotaExceeded). Esperando {wait_time}s para reintentar (intento {attempt}/5)...")
            time.sleep(wait_time)
            token = get_access_token()  # Refrescar token por si expira
        else:
            raise RuntimeError(f"Error al registrar Feed ({feed_res.status_code}): {feed_res.text}")

    raise RuntimeError(f"Error al registrar Feed tras 5 reintentos por exceso de cuota.")


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
            timeout=20,
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


def run_sync(dry_run: bool = False, custom_file: Optional[str] = None, target_marketplaces: Optional[List[str]] = None):
    """Función principal del proceso de sincronización multiterritorio."""
    os.makedirs(LOG_DIR, exist_ok=True)
    if not target_marketplaces:
        target_marketplaces = ["ES", "DE", "FR", "IT"]

    mkt_str = ", ".join([f"{MARKETPLACES[c]['flag']} {MARKETPLACES[c]['name']} ({c})" for c in target_marketplaces])
    log("=" * 70)
    log(f"INICIO DE SINCRONIZACIÓN DIARIA DE STOCK Y PRECIOS")
    log(f"Mercados seleccionados: {mkt_str}")
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

    try:
        publish_stock_snapshot(file_path, items)
    except Exception as e:
        log(f"⚠️ No se pudo guardar la copia de stock en Supabase: {e}")

    load_fbm_floors()

    seller_id = DEFAULT_SELLER_ID
    log(f"Cuenta Vendedor (Seller ID): {seller_id}")

    # 3. Dividir en lotes de hasta BATCH_SIZE (máx permitido por Amazon: 25.000)
    batches = [items[i:i + BATCH_SIZE] for i in range(0, len(items), BATCH_SIZE)]
    log(f"Total de lotes por mercado:   {len(batches)} lote(s) de hasta {BATCH_SIZE:,} SKUs")

    if dry_run:
        log("🔍 [MODO DRY-RUN ACTIVADO]: No se enviará nada a Amazon.")
        for m_code in target_marketplaces:
            mkt = MARKETPLACES[m_code]
            log(f"   [DRY-RUN] Simulado mercado {mkt['flag']} {mkt['name']} ({m_code}) con {len(batches)} lotes.")
            sample = batches[0][0]
            offset = float(mkt.get("price_offset", 0.0))
            sample_p = round(sample['price'] + offset, 2) if sample.get('price') is not None else None
            log(f"   Muestra SKU {sample['sku']}: Qty={sample['quantity']}, Precio Base ES={sample['price']} EUR -> Precio {m_code}={sample_p} EUR (+{offset}€)")
        log("✅ Simulación completada con éxito para todos los mercados.")
        return

    # 4. Enviar lotes a cada mercado
    all_submitted_feed_ids = []
    for m_code in target_marketplaces:
        mkt = MARKETPLACES[m_code]
        log("-" * 70)
        log(f"🌍 Iniciando envío para {mkt['flag']} {mkt['name']} ({mkt['id']})...")
        for b_idx, batch in enumerate(batches, 1):
            try:
                feed_id = submit_feed(seller_id, batch, m_code, b_idx, len(batches))
                all_submitted_feed_ids.append((m_code, feed_id))
                if b_idx < len(batches):
                    time.sleep(20)
            except Exception as e:
                log(f"❌ Error al enviar lote {b_idx} para {m_code}: {e}")
        time.sleep(25)

    # 5. Monitorizar primeros feeds si hay tiempo
    for m_code, feed_id in all_submitted_feed_ids[:2]:
        try:
            poll_feed_status(feed_id, timeout_seconds=90)
        except Exception as e:
            log(f"⚠️ Error al consultar estado del feed {feed_id}: {e}")

    log("=" * 70)
    log(f"SINCRONIZACIÓN FINALIZADA: {len(all_submitted_feed_ids)} feed(s) enviados a Amazon a través de {len(target_marketplaces)} mercado(s).")
    log("=" * 70)


def main():
    parser = argparse.ArgumentParser(description="Sincronizador diario de Stock y Precios para Amazon SP-API (Europa).")
    parser.add_argument("--dry-run", action="store_true", help="Simula el proceso sin enviar nada a Amazon")
    parser.add_argument("--file", type=str, help="Ruta manual al archivo de stock (.xlsm o .csv)")
    parser.add_argument("-m", "--marketplaces", default="ALL", help="Mercados a sincronizar: ES, DE, FR, IT o ALL (por defecto: ALL)")
    args = parser.parse_args()

    target_mkts = resolve_marketplaces(args.marketplaces)

    try:
        run_sync(dry_run=args.dry_run, custom_file=args.file, target_marketplaces=target_mkts)
    except Exception as e:
        log(f"💥 ERROR CRÍTICO: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
