#!/usr/bin/env python3
"""
Herramienta de Auditoría y Corrección Masiva de Precios en Oferta para Amazon SP-API.
Soporta múltiples marketplaces: España (ES), Alemania (DE), Francia (FR) e Italia (IT).

Detecta listings con 'discounted_price' (precio de oferta temporal) o precios anómalos
derivados de ofertas erróneas y los neutraliza de inmediato expirando la oferta
y restableciendo el PVP oficial del catálogo maestro.

Uso:
    # 1. Corregir un SKU concreto en TODOS los marketplaces (ES, DE, FR, IT):
    python3 fix_offer_prices.py --sku=40500SGI

    # 2. Corregir un SKU solo en Alemania, Francia e Italia:
    python3 fix_offer_prices.py --sku=40500SGI --marketplaces=DE,FR,IT

    # 3. Escanear SKUs de Signes Grimalt (SGI) en Alemania:
    python3 fix_offer_prices.py --prefix=SGI --marketplaces=DE --scan

    # 4. Corregir todos los SKUs de Signes Grimalt (SGI) en DE, FR, IT:
    python3 fix_offer_prices.py --prefix=SGI --marketplaces=DE,FR,IT --fix

    # 5. Escanear todo el catálogo activo con stock en toda Europa:
    python3 fix_offer_prices.py --scan-all --marketplaces=ALL

    # 6. Corregir anomalías en todo el catálogo europeo con simulación previa:
    python3 fix_offer_prices.py --fix-all --marketplaces=ALL --dry-run
"""

import os
import sys
import time
import json
import csv
import argparse
from datetime import datetime
from typing import Optional, Dict, Any, List

import requests
from auth import get_access_token, get_base_url

MARKETPLACES = {
    "ES": {"id": "A1RKKUPIHCS9HS", "name": "España", "locale": "es_ES", "flag": "🇪🇸", "price_offset": 0.0},
    "DE": {"id": "A1PA6795UKMFR9", "name": "Alemania", "locale": "de_DE", "flag": "🇩🇪", "price_offset": 5.0},
    "FR": {"id": "A13V1IB3VIYZZH", "name": "Francia", "locale": "fr_FR", "flag": "🇫🇷", "price_offset": 6.0},
    "IT": {"id": "APJ6JRA9NG5V4", "name": "Italia", "locale": "it_IT", "flag": "🇮🇹", "price_offset": 7.0},
}

SELLER_ID = os.getenv("SP_API_SELLER_ID", "A3RY0L9OY3TPHI").strip()
STOCK_DIR = "/Users/christianvidalwolf/Stock"
STOCK_CSV = os.path.join(STOCK_DIR, "STOCK AMZ.csv")


def log(msg: str):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {msg}", flush=True)


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


def load_master_prices() -> Dict[str, Dict[str, Any]]:
    """Carga los precios oficiales desde STOCK AMZ.csv o el archivo más reciente."""
    master = {}
    if not os.path.exists(STOCK_CSV):
        log(f"⚠️ No se encontró {STOCK_CSV}. Se buscarán precios alternativos.")
        return master

    with open(STOCK_CSV, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.reader(f, delimiter="\t")
        for row in reader:
            if not row or len(row) < 3:
                continue
            sku = row[0].strip()
            if not sku or sku.upper() in ("SKU", "ABC123") or sku.startswith("#"):
                continue

            try:
                stock = int(float(row[2].replace(",", ".").strip()))
            except (ValueError, IndexError):
                stock = 0

            price = None
            if len(row) > 6 and row[6].strip():
                try:
                    price = round(float(row[6].replace(",", ".").strip()), 2)
                except ValueError:
                    pass

            min_price = None
            if len(row) > 8 and row[8].strip():
                try:
                    min_price = round(float(row[8].replace(",", ".").strip()), 2)
                except ValueError:
                    pass

            max_price = None
            if len(row) > 9 and row[9].strip():
                try:
                    max_price = round(float(row[9].replace(",", ".").strip()), 2)
                except ValueError:
                    pass

            if price is not None:
                if min_price is None:
                    min_price = round(price * 0.5, 2)
                if max_price is None:
                    max_price = round(price * 2.0, 2)

                master[sku] = {
                    "price": price,
                    "min_price": min_price,
                    "max_price": max_price,
                    "stock": stock,
                }

    log(f"📚 {len(master):,} precios oficiales cargados desde STOCK AMZ.csv.")
    return master


def check_sku_discount(sku: str, token: str, base_url: str, marketplace_code: str, expected_price: Optional[float] = None) -> Optional[Dict[str, Any]]:
    """Consulta el SKU en Listings Items API para un marketplace concreto."""
    mkt = MARKETPLACES.get(marketplace_code, MARKETPLACES["ES"])
    marketplace_id = mkt["id"]
    url = f"{base_url}/listings/2021-08-01/items/{SELLER_ID}/{sku}?marketplaceIds={marketplace_id}&includedData=attributes,issues,offers"
    headers = {"x-amz-access-token": token}

    try:
        res = requests.get(url, headers=headers, timeout=20)
    except Exception as e:
        return {"error": str(e), "marketplace": marketplace_code}

    if res.status_code == 404:
        return None
    elif res.status_code == 429:
        time.sleep(2)
        return check_sku_discount(sku, get_access_token(), base_url, marketplace_code, expected_price)
    elif res.status_code != 200:
        return {"error": f"HTTP {res.status_code}: {res.text}", "marketplace": marketplace_code}

    data = res.json()
    po = data.get("attributes", {}).get("purchasable_offer", [])

    has_active_discount = False
    discount_details = None
    our_price = None
    now_iso = datetime.utcnow().isoformat()

    for offer in po:
        if offer.get("our_price"):
            try:
                our_price = offer["our_price"][0]["schedule"][0]["value_with_tax"]
            except (IndexError, KeyError):
                pass

        discounts = offer.get("discounted_price", [])
        for d in discounts:
            for s in d.get("schedule", []):
                end_at = s.get("end_at", "")
                val = s.get("value_with_tax")
                if end_at and end_at > now_iso:
                    has_active_discount = True
                    discount_details = {
                        "value": val,
                        "start_at": s.get("start_at"),
                        "end_at": end_at,
                    }

    b2b_price = None
    for o in data.get("offers", []):
        if o.get("offerType") == "B2B":
            b2b_price = o.get("price", {}).get("amount")

    issues = [i.get("code") for i in data.get("issues", [])]
    suppressed = "18155" in issues or "18639" in issues

    # Detectar precio severamente rebajado frente al PVP oficial esperado para este mercado
    offset = float(mkt.get("price_offset", 0.0))
    mkt_expected_price = round(expected_price + offset, 2) if expected_price is not None else None

    severe_underprice = False
    if mkt_expected_price and our_price and float(our_price) < float(mkt_expected_price) * 0.7:
        severe_underprice = True

    b2b_anomaly = False
    if b2b_price and our_price and float(b2b_price) < float(our_price) * 0.7:
        b2b_anomaly = True

    if has_active_discount or severe_underprice or b2b_anomaly:
        return {
            "sku": sku,
            "marketplace": marketplace_code,
            "our_price": our_price,
            "expected_price": expected_price,
            "discount": discount_details,
            "b2b_price": b2b_price,
            "suppressed": suppressed,
            "severe_underprice": severe_underprice,
            "issues": issues,
        }

    return None


def fix_sku_offer(sku: str, base_price: float, min_price: Optional[float], max_price: Optional[float], marketplace_code: str, dry_run: bool = False) -> Dict[str, Any]:
    """
    Neutraliza la oferta fijando en el marketplace correspondiente:
      - our_price = PVP base (España) + offset por país (DE +5€, FR +6€, IT +7€)
      - discounted_price expirado (valor = PVP con offset, fin en el pasado)
      - min/max precios de seguridad ajustados con el offset
    """
    mkt = MARKETPLACES.get(marketplace_code, MARKETPLACES["ES"])
    marketplace_id = mkt["id"]
    offset = float(mkt.get("price_offset", 0.0))

    final_price = round(base_price + offset, 2)
    min_p = round((min_price if min_price is not None else (base_price * 0.5)) + offset, 2)
    max_p = round((max_price if max_price is not None else (base_price * 2.0)) + offset, 2)

    if dry_run:
        log(f"   [DRY-RUN] Simulado fix para SKU {sku} en {mkt['flag']} {mkt['name']}: Precio={final_price} EUR (offset +{offset}€) (expirando oferta)")
        return {"success": True, "sku": sku, "marketplace": marketplace_code, "dry_run": True}

    token = get_access_token()
    base_url = get_base_url()
    url = f"{base_url}/listings/2021-08-01/items/{SELLER_ID}/{sku}?marketplaceIds={marketplace_id}"
    headers = {"x-amz-access-token": token, "Content-Type": "application/json"}

    patch_payload = {
        "productType": "PRODUCT",
        "patches": [
            {
                "op": "replace",
                "path": "/attributes/purchasable_offer",
                "value": [
                    {
                        "currency": "EUR",
                        "audience": "ALL",
                        "marketplace_id": marketplace_id,
                        "our_price": [{"schedule": [{"value_with_tax": final_price}]}],
                        "minimum_seller_allowed_price": [{"schedule": [{"value_with_tax": min_p}]}],
                        "maximum_seller_allowed_price": [{"schedule": [{"value_with_tax": max_p}]}],
                        "discounted_price": [
                            {
                                "schedule": [
                                    {
                                        "start_at": "2026-01-01",
                                        "end_at": "2026-01-02",
                                        "value_with_tax": final_price,
                                    }
                                ]
                            }
                        ],
                    }
                ],
            }
        ],
    }

    for attempt in range(5):
        res = requests.patch(url, headers=headers, json=patch_payload, timeout=20)
        if res.status_code == 200:
            return {"success": True, "sku": sku, "marketplace": marketplace_code, "data": res.json()}
        elif res.status_code == 429:
            time.sleep(2)
            token = get_access_token()
            headers["x-amz-access-token"] = token
        else:
            return {"success": False, "sku": sku, "marketplace": marketplace_code, "error": f"HTTP {res.status_code}: {res.text}"}

    return {"success": False, "sku": sku, "marketplace": marketplace_code, "error": "Excedido límite de reintentos"}


def main():
    parser = argparse.ArgumentParser(description="Auditor y corrector de precios en oferta en Amazon SP-API (Europa)")
    parser.add_argument("--sku", help="SKU individual a corregir")
    parser.add_argument("--prefix", help="Filtrar por prefijo de SKU (ej: SGI, VC, CLM)")
    parser.add_argument("-m", "--marketplaces", default="ALL", help="Mercados a procesar: ES, DE, FR, IT o ALL (por defecto: ALL)")
    parser.add_argument("--scan", action="store_true", help="Solo escanear y reportar ofertas anómalas")
    parser.add_argument("--scan-all", action="store_true", help="Escanear todo el catálogo con stock")
    parser.add_argument("--fix", action="store_true", help="Corregir los productos detectados")
    parser.add_argument("--fix-all", action="store_true", help="Escanear y corregir todo el catálogo activo")
    parser.add_argument("--dry-run", action="store_true", help="Simulación sin cambios reales")

    args = parser.parse_args()
    master_prices = load_master_prices()
    target_mkts = resolve_marketplaces(args.marketplaces)

    mkt_str = ", ".join([f"{MARKETPLACES[c]['flag']} {MARKETPLACES[c]['name']} ({c})" for c in target_mkts])
    log(f"🌍 Mercados seleccionados: {mkt_str}")

    # Caso 1: SKU individual
    if args.sku:
        sku = args.sku.strip()
        info = master_prices.get(sku)
        if not info:
            log(f"⚠️ SKU {sku} no encontrado en STOCK AMZ.csv. Se usará estimación de precio.")
            p = 70.60 if "40500" in sku else 20.0
            info = {"price": p, "min_price": round(p * 0.5, 2), "max_price": round(p * 2.0, 2)}

        log(f"🔧 Procesando SKU {sku} -> PVP {info['price']} EUR (Min: {info['min_price']}, Max: {info['max_price']})...")
        for m_code in target_mkts:
            res = fix_sku_offer(sku, info["price"], info["min_price"], info["max_price"], m_code, dry_run=args.dry_run)
            flag = MARKETPLACES[m_code]['flag']
            if res.get("success"):
                log(f"   {flag} [{m_code}] ¡SKU {sku} corregido con éxito en Amazon! Oferta neutralizada.")
            else:
                log(f"   {flag} [{m_code}] ❌ Error al corregir {sku}: {res.get('error')}")
        return

    # Caso 2: Escanear / Corregir por prefijo o catálogo
    target_skus = []
    if args.prefix:
        pref = args.prefix.strip().upper()
        target_skus = [s for s in master_prices.keys() if pref in s.upper()]
        log(f"🔍 Seleccionados {len(target_skus):,} SKUs con prefijo/cadena '{pref}'.")
    elif args.scan_all or args.fix_all:
        target_skus = [s for s, inf in master_prices.items() if inf.get("stock", 0) > 0]
        log(f"🔍 Seleccionados {len(target_skus):,} SKUs activos con stock > 0.")
    else:
        parser.print_help()
        return

    token = get_access_token()
    base_url = get_base_url()

    log(f"🚀 Iniciando escaneo de {len(target_skus):,} SKUs en {len(target_mkts)} mercado(s)...")
    anomalous = []

    req_count = 0
    for idx, sku in enumerate(target_skus, 1):
        p_info = master_prices.get(sku, {})
        expected_p = p_info.get("price")

        for m_code in target_mkts:
            req_count += 1
            if req_count % 50 == 0:
                token = get_access_token()

            res = check_sku_discount(sku, token, base_url, m_code, expected_price=expected_p)
            if res and not res.get("error"):
                flag = MARKETPLACES[m_code]['flag']
                disc = res.get("discount")
                disc_str = f"{disc['value']} EUR (hasta {disc['end_at'][:10]})" if disc else "Sin promo"
                b2b_str = f"B2B: {res.get('b2b_price')} EUR" if res.get("b2b_price") else ""
                severe_str = " ⚠️ [PRECIO MUY BAJO]" if res.get("severe_underprice") else ""
                log(f"🚨 [{idx}/{len(target_skus)}] {flag} [{m_code}] SKU {sku}: Actual={res.get('our_price')} EUR | Oficial={expected_p} EUR | Oferta={disc_str} {b2b_str}{severe_str}")
                anomalous.append((sku, m_code, res))

                if args.fix or args.fix_all:
                    price = expected_p or (float(res["our_price"]) if res.get("our_price") else None)
                    if price:
                        min_p = p_info.get("min_price", round(price * 0.5, 2))
                        max_p = p_info.get("max_price", round(price * 2.0, 2))
                        f_res = fix_sku_offer(sku, price, min_p, max_p, m_code, dry_run=args.dry_run)
                        if f_res.get("success"):
                            log(f"   ✅ [FIXED] {flag} [{m_code}] Oferta neutralizada para {sku}.")
                        else:
                            log(f"   ❌ [ERROR] {flag} [{m_code}] Falló fix para {sku}: {f_res.get('error')}")

            time.sleep(0.2)

    log("=" * 70)
    log(f"🏁 Finalizado: {len(anomalous)} anomalías detectadas en {len(target_skus)} SKUs analizados.")
    log("=" * 70)


if __name__ == "__main__":
    main()
