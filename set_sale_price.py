#!/usr/bin/env python3
"""
Pone un precio de oferta (discounted_price) a un SKU en uno o varios marketplaces EU.

Uso:
    python3 set_sale_price.py --sku=24040SGFBA --pais=DE --oferta=15.95 --hasta=2027-12-31
    python3 set_sale_price.py --sku=24040SGFBA --pais=DE,FR --oferta=15.95 --hasta=2027-12-31 --precio=17.95 --apply

Sin --apply solo muestra el PATCH. Con --apply la oferta se guarda también en Supabase (rules:sales)
para que el feed diario de stock (sync_daily_stock_amz.py) la mantenga en vez de anularla. El precio normal (our_price) no cambia; con --precio se exige
que sea ese antes de enviar. Aplica la regla de backend/src/lib/priceBounds.ts: con oferta vigente,
mínimo = mitad del precio de oferta; si el precio normal supera el máximo, el máximo pasa al doble.
"""

import argparse
import json
import sys
from datetime import date, datetime
from typing import Optional

import requests
from auth import get_access_token, get_base_url
from price_overrides import record_sale
from sync_prices_stock import MARKETPLACES, SELLER_ID, _first_value, log


def get_offer(sku: str, marketplace_id: str) -> Optional[dict]:
    url = f"{get_base_url()}/listings/2021-08-01/items/{SELLER_ID}/{sku}?marketplaceIds={marketplace_id}&includedData=attributes"
    res = requests.get(url, headers={"x-amz-access-token": get_access_token()}, timeout=20)
    res.raise_for_status()
    offers = res.json().get("attributes", {}).get("purchasable_offer", [])
    return next((o for o in offers if o.get("audience", "ALL") == "ALL"), None)


def set_sale(sku: str, country: str, sale: float, start: str, end: str, expected_price: Optional[float], apply: bool) -> bool:
    mkt = MARKETPLACES[country]
    marketplace_id = mkt["id"]
    offer = get_offer(sku, marketplace_id)
    if not offer:
        log(f"❌ [{mkt['name']}] {sku}: no tiene oferta en este marketplace")
        return False

    price = _first_value(offer.get("our_price"))
    if price is None:
        log(f"❌ [{mkt['name']}] {sku}: sin our_price")
        return False
    if expected_price is not None and abs(price - expected_price) > 0.001:
        log(f"❌ [{mkt['name']}] {sku}: el precio actual es {price}, no {expected_price}; no se toca")
        return False
    if sale >= price:
        log(f"❌ [{mkt['name']}] {sku}: la oferta {sale} no es menor que el precio {price}")
        return False

    value = {
        "currency": mkt["currency"],
        "audience": "ALL",
        "marketplace_id": marketplace_id,
        "our_price": [{"schedule": [{"value_with_tax": price}]}],
        "discounted_price": [{"schedule": [{"start_at": start, "end_at": end, "value_with_tax": sale}]}],
        "minimum_seller_allowed_price": [{"schedule": [{"value_with_tax": round(sale / 2, 2)}]}],
    }
    cur_max = _first_value(offer.get("maximum_seller_allowed_price"))
    if cur_max is not None and cur_max < price:
        value["maximum_seller_allowed_price"] = [{"schedule": [{"value_with_tax": round(price * 2, 2)}]}]
    payload = {"productType": "PRODUCT", "patches": [{"op": "replace", "path": "/attributes/purchasable_offer", "value": [value]}]}

    log(f"🔄 [{mkt['name']}] {sku}: {price} -> oferta {sale} ({start} → {end})")
    if not apply:
        print(json.dumps(payload, indent=2))
        log("   [DRY-RUN] Añade --apply para enviarlo")
        return True

    url = f"{get_base_url()}/listings/2021-08-01/items/{SELLER_ID}/{sku}?marketplaceIds={marketplace_id}"
    res = requests.patch(url, headers={"x-amz-access-token": get_access_token(), "Content-Type": "application/json"}, json=payload, timeout=20)
    data = res.json() if res.content else {}
    if res.status_code != 200 or data.get("status") != "ACCEPTED":
        log(f"   ❌ HTTP {res.status_code}: {res.text}")
        return False
    log(f"   ✅ Aceptado por Amazon (Submission: {data.get('submissionId')})")
    try:
        record_sale(sku, country, sale, start, end)
        log("   ☁️ Oferta registrada en Supabase (rules:sales) para el feed diario de stock")
    except Exception as e:
        log(f"   ⚠️ No se pudo registrar la oferta en Supabase; el feed diario de stock podría anularla: {e}")
    return True


def main():
    parser = argparse.ArgumentParser(description="Pone un precio de oferta a un SKU en Amazon EU.")
    parser.add_argument("--sku", required=True)
    parser.add_argument("--pais", required=True, help="Uno o varios de ES,DE,FR,IT separados por comas")
    parser.add_argument("--oferta", type=float, required=True, help="Precio de oferta con IVA")
    parser.add_argument("--hasta", required=True, help="Último día de la oferta (YYYY-MM-DD), incluido, hora de España")
    parser.add_argument("--desde", default=date.today().isoformat(), help="Primer día (YYYY-MM-DD), por defecto hoy")
    parser.add_argument("--precio", type=float, help="Precio normal esperado; si no coincide, no se envía")
    parser.add_argument("--apply", action="store_true", help="Envía el cambio a Amazon")
    args = parser.parse_args()

    countries = [c.strip().upper() for c in args.pais.split(",") if c.strip()]
    unknown = [c for c in countries if c not in MARKETPLACES]
    if unknown:
        sys.exit(f"Marketplace desconocido: {', '.join(unknown)}")
    end_day = datetime.strptime(args.hasta, "%Y-%m-%d").date()
    if end_day < datetime.strptime(args.desde, "%Y-%m-%d").date():
        sys.exit("--hasta es anterior a --desde")
    # Hora de España: +01:00 en invierno, +02:00 en verano (aprox. abril–octubre).
    offset = "+02:00" if 4 <= end_day.month <= 10 else "+01:00"
    end = f"{args.hasta}T23:59:59{offset}"

    ok = all([set_sale(args.sku, c, args.oferta, args.desde, end, args.precio, args.apply) for c in countries])
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
