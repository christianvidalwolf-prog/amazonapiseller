#!/usr/bin/env python3
"""
Catálogo del chatbot de www.vidalregals.com (spec: specs/chatbot/chatbot.spec.md).

Lee del Webservice de PrestaShop (solo GET) los productos activos con su precio con IVA, stock,
categoría, imagen y URL, y publica una copia compacta en Supabase `snapshots`
(clave `chatbot:catalog`), que es lo que busca la ruta pública /api/public/chat del frontend.

Uso:
    python3 prestashop/build_chat_catalog.py              # construye y publica
    python3 prestashop/build_chat_catalog.py --dry-run    # construye y guarda una copia local, sin publicar

Variables: PS_URL, PS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
"""

import argparse
import html
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT_KEY = "chatbot:catalog"
LANG_ID = 1            # es
SPAIN_COUNTRY_ID = 6   # id_country de España en PrestaShop
DEFAULT_VAT = 0.21
PAGE_SIZE = 1000
DESCRIPTION_CHARS = 220


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip() and not os.environ.get(key.strip()):
            os.environ[key.strip()] = value.strip().strip('"').strip("'")


load_dotenv(REPO_ROOT / ".env")

# Un secreto de GitHub sin definir llega como cadena vacía, no como variable ausente.
PS_URL = (os.environ.get("PS_URL") or "https://www.vidalregals.com").strip().rstrip("/")
PS_API_KEY = os.environ.get("PS_API_KEY", "").strip()
session = requests.Session()
session.headers["User-Agent"] = "vidalregals-chatbot-catalog/1.0"
auth_mode = "basic"


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def ps_get(resource: str, params: dict) -> list:
    """GET de una colección del Webservice; devuelve la lista (vacía si no hay filas)."""
    global auth_mode
    url = f"{PS_URL}/api/{resource}"
    query = {"output_format": "JSON", **params}
    if auth_mode == "query":
        resp = session.get(url, params={**query, "ws_key": PS_API_KEY}, timeout=120)
    else:
        resp = session.get(url, params=query, auth=(PS_API_KEY, ""), timeout=120)
        if resp.status_code == 401:
            # Muchos hostings eliminan la cabecera Authorization; se pasa la key por query.
            auth_mode = "query"
            resp = session.get(url, params={**query, "ws_key": PS_API_KEY}, timeout=120)
    if resp.status_code >= 400:
        raise RuntimeError(f"PrestaShop GET {resource} -> HTTP {resp.status_code}: {resp.text[:300]}")
    text = resp.text.strip()
    if text in ("", "[]"):
        return []
    return resp.json().get(resource, [])


def ps_get_all(resource: str, params: dict) -> list:
    """Pagina la colección (el listado completo sin paginar da timeout en esta tienda)."""
    rows, offset = [], 0
    while True:
        page = ps_get(resource, {"sort": "[id_ASC]", **params, "limit": f"{offset},{PAGE_SIZE}"})
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE


def lang_value(field) -> str:
    """Campos multidioma: string si se pidió `language`, o lista [{id, value}] según versión."""
    if isinstance(field, list):
        match = next((x for x in field if str(x.get("id")) == str(LANG_ID)), field[0] if field else {})
        return str(match.get("value") or "")
    return str(field or "")


def plain_text(raw: str, limit: int) -> str:
    text = re.sub(r"<[^>]+>", " ", raw or "")
    text = re.sub(r"\s+", " ", html.unescape(text)).strip()
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


def vat_rates_by_group() -> dict:
    """Tipo de IVA de España por id_tax_rules_group; fallback 21 % si no se puede leer."""
    try:
        taxes = {str(t["id"]): float(t["rate"]) / 100 for t in ps_get("taxes", {"display": "[id,rate]"})}
        rules = ps_get_all("tax_rules", {"display": "[id_tax_rules_group,id_tax]", "filter[id_country]": f"[{SPAIN_COUNTRY_ID}]"})
        return {str(r["id_tax_rules_group"]): taxes.get(str(r["id_tax"]), DEFAULT_VAT) for r in rules}
    except Exception as e:  # noqa: BLE001 — el catálogo sigue siendo útil con el 21 %
        log(f"⚠️ No se pudieron leer los impuestos ({e}); se usa {DEFAULT_VAT:.0%}.")
        return {}


def build_catalog() -> dict:
    if not PS_API_KEY:
        raise RuntimeError("Falta PS_API_KEY (key del Webservice de PrestaShop).")

    log("Categorías…")
    categories = {
        str(c["id"]): {"name": lang_value(c.get("name")), "slug": lang_value(c.get("link_rewrite"))}
        for c in ps_get_all("categories", {"display": "[id,name,link_rewrite]", "language": LANG_ID})
    }
    log(f"  {len(categories):,} categorías")

    log("Stock…")
    stock = {
        str(s["id_product"]): int(float(s.get("quantity") or 0))
        for s in ps_get_all("stock_availables", {"display": "[id_product,quantity]", "filter[id_product_attribute]": "[0]"})
    }

    vat = vat_rates_by_group()

    log("Productos activos…")
    fields = "[id,name,reference,ean13,price,id_tax_rules_group,id_category_default,link_rewrite,id_default_image,description_short,visibility,available_for_order]"
    products = ps_get_all("products", {"display": fields, "filter[active]": "[1]", "language": LANG_ID})
    log(f"  {len(products):,} productos activos")

    items = []
    for p in products:
        pid = str(p["id"])
        # Activos pero ocultos o no comprables: el cliente no podría verlos ni pedirlos.
        if str(p.get("visibility") or "both") == "none" or str(p.get("available_for_order", "1")) == "0":
            continue
        name = plain_text(lang_value(p.get("name")), 200)
        if not name:
            continue
        slug = lang_value(p.get("link_rewrite")) or "producto"
        cat = categories.get(str(p.get("id_category_default")), {"name": "", "slug": ""})
        rate = vat.get(str(p.get("id_tax_rules_group")), DEFAULT_VAT if str(p.get("id_tax_rules_group")) != "0" else 0.0)
        price = round(float(p.get("price") or 0) * (1 + rate), 2)
        image_id = str(p.get("id_default_image") or "")
        ean = str(p.get("ean13") or "").strip()
        # PrestaShop redirige cualquier URL con el id correcto a la canónica; se imita su formato.
        url_path = f"{cat['slug']}/" if cat["slug"] else ""
        url = f"{PS_URL}/es/{url_path}{pid}-{slug}{'-' + ean if ean else ''}.html"
        items.append({
            "id": int(pid),
            "name": name,
            "ref": str(p.get("reference") or ""),
            "price": price,
            "stock": stock.get(pid, 0),
            "category": cat["name"],
            "url": url,
            "image": f"{PS_URL}/{image_id}-home_default/{slug}.jpg" if image_id and image_id != "0" else "",
            "description": plain_text(lang_value(p.get("description_short")), DESCRIPTION_CHARS),
        })

    items.sort(key=lambda x: x["id"])
    return {"updatedAt": datetime.now(timezone.utc).isoformat(), "shopUrl": PS_URL, "count": len(items), "products": items}


def publish(catalog: dict) -> None:
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    if url and not url.startswith("http"):
        url = f"https://{url}"
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise RuntimeError("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
    resp = requests.post(
        f"{url}/rest/v1/snapshots?on_conflict=key",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        data=json.dumps({"key": SNAPSHOT_KEY, "data": catalog, "updated_at": catalog["updatedAt"]}),
        timeout=120,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"Supabase respondió {resp.status_code}: {resp.text[:300]}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="No publica; guarda prestashop/data/chat_catalog.json")
    args = parser.parse_args()

    catalog = build_catalog()
    in_stock = sum(1 for p in catalog["products"] if p["stock"] > 0)
    size_mb = len(json.dumps(catalog)) / 1_048_576
    log(f"Catálogo: {catalog['count']:,} productos ({in_stock:,} con stock), {size_mb:.1f} MB")
    if catalog["count"] == 0:
        log("❌ Catálogo vacío; no se publica para no dejar el chatbot sin productos.")
        return 1

    if args.dry_run:
        out = REPO_ROOT / "prestashop" / "data" / "chat_catalog.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(catalog, ensure_ascii=False))
        log(f"Dry-run: guardado en {out}")
        return 0

    publish(catalog)
    log(f"✅ Publicado en Supabase snapshots['{SNAPSHOT_KEY}']")
    return 0


if __name__ == "__main__":
    sys.exit(main())
