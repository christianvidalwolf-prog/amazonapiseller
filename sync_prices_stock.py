#!/usr/bin/env python3
"""
Script de Sincronización Automática de Precios y Stock con Amazon SP-API.

Uso:
    python3 sync_prices_stock.py --csv=mi_archivo.csv [--dry-run]
    python3 sync_prices_stock.py --sku=MI_SKU --precio=15.99
    python3 sync_prices_stock.py --sku=MI_SKU --stock=25 --lead-time=2
    python3 sync_prices_stock.py --sku=MI_SKU --precio=19.95 --stock=10

Formatos de CSV soportados (delimitador ';' o ','):
    sku;precio;stock;lead_time_days
    27593SGFBA;12.50;;
    2676192CLM;28.90;50;2
"""

import os
import sys
import time
import csv
import argparse
from typing import Optional
from datetime import datetime
import requests
from auth import get_access_token, get_base_url

# Marketplaces de la región EU soportados
MARKETPLACES = {
    "ES": {"id": "A1RKKUPIHCS9HS", "name": "España", "currency": "EUR"},
    "FR": {"id": "A13V1IB3VIYZZH", "name": "Francia", "currency": "EUR"},
    "IT": {"id": "APJ6JRA9NG5V4", "name": "Italia", "currency": "EUR"},
    "DE": {"id": "A1PA6795UKMFR9", "name": "Alemania", "currency": "EUR"},
}

SELLER_ID = os.getenv("SP_API_SELLER_ID", "A3RY0L9OY3TPHI").strip()
DEFAULT_MARKETPLACE_ID = os.getenv("SP_API_MARKETPLACE_IDS", "A1RKKUPIHCS9HS").split(",")[0].strip()


def resolve_marketplace(country_code_or_id: Optional[str]) -> tuple:
    """Devuelve (marketplace_id, currency, country_name)."""
    if not country_code_or_id:
        return DEFAULT_MARKETPLACE_ID, "EUR", "España (por defecto)"
    
    code = country_code_or_id.strip().upper()
    if code in MARKETPLACES:
        m = MARKETPLACES[code]
        return m["id"], m["currency"], m["name"]
    
    # Comprobar si han pasado el ID directamente (ej: A1RKKUPIHCS9HS)
    for k, v in MARKETPLACES.items():
        if v["id"] == code:
            return v["id"], v["currency"], v["name"]
            
    return code, "EUR", code


def log(msg: str):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {msg}")


def update_listing_item(
    sku: str,
    price: Optional[float] = None,
    stock: Optional[int] = None,
    lead_time_days: int = 2,
    currency: str = "EUR",
    marketplace_id: str = DEFAULT_MARKETPLACE_ID,
    dry_run: bool = False,
) -> dict:
    """
    Envía una petición PATCH a Listings Items API para actualizar precio, stock o ambos.
    """
    if price is None and stock is None:
        return {"success": False, "sku": sku, "message": "No se especificó ni precio ni stock."}

    patches = []

    # 1. Parche de Precio
    if price is not None:
        patches.append({
            "op": "replace",
            "path": "/attributes/purchasable_offer",
            "value": [
                {
                    "currency": currency,
                    "marketplace_id": marketplace_id,
                    "our_price": [
                        {
                            "schedule": [
                                {
                                    "value_with_tax": round(float(price), 2)
                                }
                            ]
                        }
                    ],
                }
            ],
        })

    # 2. Parche de Stock (Fulfillment Availability para FBM)
    if stock is not None:
        patches.append({
            "op": "replace",
            "path": "/attributes/fulfillment_availability",
            "value": [
                {
                    "fulfillment_channel_code": "DEFAULT",
                    "quantity": int(stock),
                    "lead_time_to_ship_max_days": int(lead_time_days),
                }
            ],
        })

    payload = {
        "productType": "PRODUCT",
        "patches": patches,
    }

    if dry_run:
        log(f"   [DRY-RUN] Simulado SKU={sku} | Precio={price} | Stock={stock}")
        return {"success": True, "sku": sku, "dry_run": True, "payload": payload}

    base_url = get_base_url()
    url = f"{base_url}/listings/2021-08-01/items/{SELLER_ID}/{sku}?marketplaceIds={marketplace_id}"

    # Reintentos automáticos en caso de rate limiting (429) o micro-cortes
    for attempt in range(5):
        token = get_access_token()
        headers = {
            "x-amz-access-token": token,
            "Content-Type": "application/json",
        }

        res = requests.patch(url, headers=headers, json=payload)
        
        if res.status_code == 200:
            data = res.json()
            return {
                "success": True,
                "sku": sku,
                "status": data.get("status"),
                "submissionId": data.get("submissionId"),
                "issues": data.get("issues", []),
            }
        elif res.status_code == 429:
            log(f"   ⚠️ Rate limit en SKU {sku}. Reintentando en 3s (intento {attempt + 1}/5)...")
            time.sleep(3)
        else:
            return {
                "success": False,
                "sku": sku,
                "status_code": res.status_code,
                "error": res.text,
            }

    return {"success": False, "sku": sku, "error": "Excedido número de reintentos por rate-limit"}


def process_csv(csv_path: str, country: Optional[str] = None, dry_run: bool = False, delay_seconds: float = 0.5):
    """
    Lee un archivo CSV con columnas sku, precio, stock, lead_time_days y opcionalmente pais/marketplace.
    """
    if not os.path.exists(csv_path):
        log(f"❌ El archivo no existe: {csv_path}")
        sys.exit(1)

    default_mk_id, default_curr, default_name = resolve_marketplace(country)

    with open(csv_path, "r", encoding="utf-8-sig") as f:
        # Detectar delimitador (; o ,)
        sample = f.read(2048)
        f.seek(0)
        delimiter = ";" if ";" in sample else ","
        reader = csv.DictReader(f, delimiter=delimiter)

        # Normalizar nombres de columnas a minúsculas
        fieldnames = [fn.strip().lower() for fn in (reader.fieldnames or [])]
        rows = list(reader)

    log(f"📄 Procesando {len(rows)} filas desde {csv_path}...")
    log(f"   Mercado base: {default_name} ({default_mk_id})")
    log(f"   Modo: {'[SIMULACIÓN DRY-RUN]' if dry_run else '[REAL EN AMAZON SP-API]'}")

    success_count = 0
    error_count = 0

    for i, row in enumerate(rows, 1):
        # Normalizar claves y valores
        normalized = {k.strip().lower(): (v.strip() if v else "") for k, v in row.items() if k}
        sku = normalized.get("sku")

        # Ignorar comentarios o filas vacías
        if not sku or sku.startswith("#"):
            continue

        row_country = normalized.get("pais") or normalized.get("country") or normalized.get("marketplace")
        if row_country:
            mk_id, curr, mk_name = resolve_marketplace(row_country)
        else:
            mk_id, curr, mk_name = default_mk_id, default_curr, default_name

        raw_price = normalized.get("precio") or normalized.get("price")
        raw_stock = normalized.get("stock") or normalized.get("cantidad") or normalized.get("quantity")
        raw_lead = normalized.get("lead_time_days") or normalized.get("lead_time") or "2"

        price = None
        if raw_price:
            try:
                price = float(raw_price.replace(",", "."))
            except ValueError:
                log(f"⚠️ [{i}/{len(rows)}] SKU {sku}: precio inválido '{raw_price}'. Se omite precio.")

        stock = None
        if raw_stock:
            try:
                stock = int(raw_stock)
            except ValueError:
                log(f"⚠️ [{i}/{len(rows)}] SKU {sku}: stock inválido '{raw_stock}'. Se omite stock.")

        lead_time = 2
        try:
            lead_time = int(raw_lead)
        except ValueError:
            lead_time = 2

        if price is None and stock is None:
            continue

        cambios = []
        if price is not None:
            cambios.append(f"Precio={price:.2f} {curr}")
        if stock is not None:
            cambios.append(f"Stock={stock} (Lead={lead_time}d)")

        log(f"🔄 [{i}/{len(rows)}] [{mk_name}] Actualizando SKU '{sku}' -> {', '.join(cambios)}...")

        result = update_listing_item(
            sku=sku,
            price=price,
            stock=stock,
            lead_time_days=lead_time,
            currency=curr,
            marketplace_id=mk_id,
            dry_run=dry_run,
        )

        if result.get("success"):
            success_count += 1
            log(f"   ✅ Aceptado por Amazon (Submission: {result.get('submissionId', 'DRY-RUN')})")
        else:
            error_count += 1
            log(f"   ❌ Error en SKU {sku}: {result.get('error') or result.get('message')}")

        if not dry_run and delay_seconds > 0:
            time.sleep(delay_seconds)

    log("=" * 70)
    log(f"🏁 Finalizado: {success_count} correctos, {error_count} errores de un total de {len(rows)} filas.")
    log("=" * 70)


def main():
    parser = argparse.ArgumentParser(description="Sincronizador de Precios y Stock con Amazon SP-API")
    parser.add_argument("--csv", help="Ruta al archivo CSV con las actualizaciones")
    parser.add_argument("--pais", choices=["ES", "FR", "IT", "DE"], help="País destino (ES=España, FR=Francia, IT=Italia, DE=Alemania)")
    parser.add_argument("--sku", help="SKU individual a actualizar")
    parser.add_argument("--precio", type=float, help="Nuevo precio para el SKU individual")
    parser.add_argument("--stock", type=int, help="Nuevo stock FBM para el SKU individual")
    parser.add_argument("--lead-time", type=int, default=2, help="Días de preparación (por defecto: 2)")
    parser.add_argument("--dry-run", action="store_true", help="Simula los cambios sin enviarlos a Amazon")
    parser.add_argument("--delay", type=float, default=0.5, help="Pausa entre peticiones en segundos (por defecto: 0.5s)")

    args = parser.parse_args()

    if args.csv:
        process_csv(args.csv, country=args.pais, dry_run=args.dry_run, delay_seconds=args.delay)
    elif args.sku:
        if args.precio is None and args.stock is None:
            print("❌ Debes especificar al menos --precio o --stock para el SKU.")
            sys.exit(1)

        mk_id, curr, mk_name = resolve_marketplace(args.pais)
        log(f"Actualizando SKU '{args.sku}' en [{mk_name}] (Precio: {args.precio}, Stock: {args.stock})...")
        res = update_listing_item(
            sku=args.sku,
            price=args.precio,
            stock=args.stock,
            lead_time_days=args.lead_time,
            currency=curr,
            marketplace_id=mk_id,
            dry_run=args.dry_run,
        )
        if res.get("success"):
            log(f"✅ ¡Actualización aceptada por Amazon! SubmissionId: {res.get('submissionId')}")
        else:
            log(f"❌ Error al actualizar: {res.get('error') or res.get('message')}")
            sys.exit(1)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
