#!/usr/bin/env python3
"""
Precios fijos y ofertas decididos desde este proyecto, compartidos por Supabase (`snapshots`)
para que el feed diario de stock (sync_daily_stock_amz.py, 9:00 en el Mac de STOCK AMZ) no los pise.

  rules:fixed-prices  {updatedAt, prices: {sku: {ES: 109.0, ...}}}            ← fixed_prices.csv
  rules:sales         {updatedAt, sales: {sku: {DE: {price, start, end}}}}    ← set_sale_price.py

Uso:
    python3 price_overrides.py publish-fixed [--csv=fixed_prices.csv]
    python3 price_overrides.py show
"""

import argparse
import csv
import json
import os
from datetime import datetime, timezone
from typing import Dict, Optional, Tuple

import requests
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
FIXED_KEY = "rules:fixed-prices"
SALES_KEY = "rules:sales"
COUNTRIES = ("ES", "DE", "FR", "IT")


def _headers() -> dict:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
    return {"apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read(key: str) -> Optional[dict]:
    res = requests.get(f"{SUPABASE_URL}/rest/v1/snapshots", params={"key": f"eq.{key}", "select": "data"}, headers=_headers(), timeout=60)
    res.raise_for_status()
    rows = res.json()
    return rows[0]["data"] if rows else None


def _write(key: str, data: dict) -> None:
    headers = {**_headers(), "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"}
    res = requests.post(f"{SUPABASE_URL}/rest/v1/snapshots?on_conflict=key", headers=headers,
                        json={"key": key, "data": data, "updated_at": data["updatedAt"]}, timeout=60)
    res.raise_for_status()


def parse_time(value: str) -> datetime:
    """ISO 8601 con o sin hora/zona (Python 3.9 no acepta 'Z'); sin zona se toma UTC."""
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def is_active(sale: dict, now: Optional[datetime] = None) -> bool:
    now = now or datetime.now(timezone.utc)
    return parse_time(sale["start"]) <= now < parse_time(sale["end"])


def read_fixed_prices_csv(path: str) -> Dict[str, Dict[str, float]]:
    prices: Dict[str, Dict[str, float]] = {}
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f, delimiter=";"):
            sku = (row.get("sku") or "").strip()
            country = (row.get("pais") or "ES").strip().upper()
            raw = (row.get("precio") or "").strip().replace(",", ".")
            if sku and country in COUNTRIES and raw:
                prices.setdefault(sku, {})[country] = round(float(raw), 2)
    return prices


def publish_fixed_prices(path: str = "fixed_prices.csv") -> int:
    prices = read_fixed_prices_csv(path)
    _write(FIXED_KEY, {"updatedAt": _now(), "source": os.path.basename(path), "prices": prices})
    return sum(len(v) for v in prices.values())


def record_sale(sku: str, country: str, price: float, start: str, end: str) -> None:
    """Guarda (o sustituye) la oferta de un SKU/país y limpia las ya caducadas."""
    data = _read(SALES_KEY) or {"sales": {}}
    now = datetime.now(timezone.utc)
    sales = {
        s: {c: v for c, v in by_country.items() if parse_time(v["end"]) > now}
        for s, by_country in data.get("sales", {}).items()
    }
    sales.setdefault(sku, {})[country] = {"price": round(price, 2), "start": start, "end": end, "recordedAt": now.isoformat()}
    _write(SALES_KEY, {"updatedAt": now.isoformat(), "sales": {s: v for s, v in sales.items() if v}})


def load_overrides() -> Tuple[Dict[str, Dict[str, float]], Dict[str, Dict[str, dict]]]:
    """(precios fijos, ofertas vigentes) por SKU y país; lo que falle se devuelve vacío."""
    fixed: Dict[str, Dict[str, float]] = {}
    sales: Dict[str, Dict[str, dict]] = {}
    data = _read(FIXED_KEY)
    if data:
        fixed = data.get("prices", {})
    data = _read(SALES_KEY)
    if data:
        for sku, by_country in data.get("sales", {}).items():
            active = {c: v for c, v in by_country.items() if is_active(v)}
            if active:
                sales[sku] = active
    return fixed, sales


def main():
    parser = argparse.ArgumentParser(description="Precios fijos y ofertas compartidos con el feed diario de stock.")
    parser.add_argument("command", choices=["publish-fixed", "show"])
    parser.add_argument("--csv", default="fixed_prices.csv")
    args = parser.parse_args()
    if args.command == "publish-fixed":
        n = publish_fixed_prices(args.csv)
        print(f"☁️ {n} precios fijos publicados en Supabase ({FIXED_KEY}).")
    else:
        fixed, sales = load_overrides()
        print(json.dumps({"fixed": fixed, "activeSales": sales}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
