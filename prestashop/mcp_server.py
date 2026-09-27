# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp>=1.2,<2", "requests>=2.31"]
# ///
"""MCP server for the PrestaShop 1.7 Webservice API (vidalregals.com).

Config via environment variables (or the repo-root .env, read if they are not set):
  PS_URL           Shop base URL, e.g. https://www.vidalregals.com
  PS_API_KEY       Webservice key (Advanced Parameters > Webservice)
  PS_AUTH_MODE     "basic" (default) or "query" if the host strips the Authorization header
  PS_SCRAP_IN_DIR  Folder with scrap-in/<ASIN>/product-info.json (default: the A+ workspace)
"""
from __future__ import annotations

import html
import json
import os
import re
import unicodedata
from pathlib import Path
from xml.sax.saxutils import escape

import requests
from mcp.server.fastmcp import FastMCP

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip().startswith("PS_") and not os.environ.get(key.strip()):
            os.environ[key.strip()] = value.strip().strip('"').strip("'")


_load_dotenv(REPO_ROOT / ".env")

PS_URL = os.environ.get("PS_URL", "https://www.vidalregals.com").rstrip("/")
PS_API_KEY = os.environ.get("PS_API_KEY", "")
PS_AUTH_MODE = os.environ.get("PS_AUTH_MODE", "basic")
SCRAP_IN_DIR = Path(os.environ.get("PS_SCRAP_IN_DIR", "/Users/christianvidalwolf/A+/scrap-in"))

# Fields the webservice returns but rejects on PUT (PrestaShop 1.7 quirk).
READ_ONLY_PRODUCT_FIELDS = {"manufacturer_name", "quantity", "position_in_category", "associations"}

mcp = FastMCP("prestashop")
_session = requests.Session()
_session.headers["User-Agent"] = "prestashop-mcp/1.0"
_languages_cache: list[dict] | None = None


# ---------------------------------------------------------------- HTTP layer

def _request(method: str, path: str, params: dict | None = None, **kwargs) -> requests.Response:
    global PS_AUTH_MODE
    if not PS_API_KEY:
        raise RuntimeError("PS_API_KEY no configurada. Exporta la key del Webservice antes de arrancar el MCP.")
    url = f"{PS_URL}/api/{path.lstrip('/')}"
    params = dict(params or {})
    if PS_AUTH_MODE == "query":
        resp = _session.request(method, url, params={**params, "ws_key": PS_API_KEY}, timeout=60, **kwargs)
    else:
        resp = _session.request(method, url, params=params, auth=(PS_API_KEY, ""), timeout=60, **kwargs)
        if resp.status_code == 401:
            # Many hosts strip the Authorization header; fall back to ?ws_key= for the rest of the session.
            PS_AUTH_MODE = "query"
            resp = _session.request(method, url, params={**params, "ws_key": PS_API_KEY}, timeout=60, **kwargs)
    if resp.status_code >= 400:
        raise RuntimeError(f"PrestaShop {method} {path} -> HTTP {resp.status_code}: {resp.text[:800]}")
    return resp


def _get_json(path: str, params: dict | None = None) -> dict:
    params = {"output_format": "JSON", **(params or {})}
    resp = _request("GET", path, params)
    # Empty collections come back as "[]" in PS 1.7.
    return resp.json() if resp.text.strip() not in ("", "[]") else {}


def _send_xml(method: str, path: str, xml_body: str) -> dict:
    resp = _request(method, path, {"output_format": "JSON"}, data=xml_body.encode("utf-8"),
                    headers={"Content-Type": "application/xml"})
    return resp.json() if resp.text.strip() else {}


# ---------------------------------------------------------------- XML helpers

def _cdata(value) -> str:
    return "<![CDATA[" + str(value).replace("]]>", "]]]]><![CDATA[>") + "]]>"


def _field_xml(name: str, value) -> str:
    if isinstance(value, dict):  # multilang: {lang_id: text}
        inner = "".join(f'<language id="{lid}">{_cdata(txt)}</language>' for lid, txt in value.items())
        return f"<{name}>{inner}</{name}>"
    if isinstance(value, list):  # multilang as returned by the API: [{"id": "1", "value": "..."}]
        inner = "".join(f'<language id="{item["id"]}">{_cdata(item.get("value", ""))}</language>' for item in value)
        return f"<{name}>{inner}</{name}>"
    return f"<{name}>{_cdata('' if value is None else value)}</{name}>"


def _resource_xml(resource: str, fields: dict, associations_xml: str = "") -> str:
    body = "".join(_field_xml(k, v) for k, v in fields.items())
    if associations_xml:
        body += f"<associations>{associations_xml}</associations>"
    return f'<?xml version="1.0" encoding="UTF-8"?><prestashop xmlns:xlink="http://www.w3.org/1999/xlink"><{resource}>{body}</{resource}></prestashop>'


# ---------------------------------------------------------------- domain helpers

def _languages() -> list[dict]:
    global _languages_cache
    if _languages_cache is None:
        data = _get_json("languages", {"display": "[id,iso_code,name,active]"})
        _languages_cache = [lang for lang in data.get("languages", []) if str(lang.get("active")) == "1"]
    return _languages_cache


def _multilang(text: str) -> dict:
    return {lang["id"]: text for lang in _languages()}


def _slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:120] or "producto"


def _net_price(price: float, price_includes_tax: bool, vat_percent: float) -> str:
    net = price / (1 + vat_percent / 100) if price_includes_tax else price
    return f"{net:.6f}"


def _find_by_reference(reference: str) -> list[dict]:
    data = _get_json("products", {"filter[reference]": f"[{reference}]", "display": "[id,reference,name,active,price]"})
    return data.get("products", [])


def _clean_name(name: str) -> str:
    # PrestaShop forbids <>;=#{} in product names and caps them at 128 chars.
    return re.sub(r"[<>;=#{}]", " ", name).strip()[:128]


def _upload_image_bytes(product_id: int, filename: str, content: bytes) -> dict:
    mime = "image/png" if filename.lower().endswith(".png") else "image/jpeg"
    resp = _request("POST", f"images/products/{product_id}", files={"image": (filename, content, mime)})
    return {"file": filename, "status": resp.status_code}


# ---------------------------------------------------------------- tools

@mcp.tool()
def shop_info() -> dict:
    """Comprueba la conexión y devuelve idiomas activos y recursos permitidos por la API key."""
    resp = _request("GET", "", {"output_format": "JSON"})
    return {"url": PS_URL, "languages": _languages(), "api": resp.json() if resp.text.strip() else {}}


@mcp.tool()
def list_categories() -> list[dict]:
    """Lista categorías (id, id_parent, nombre, activa) para elegir id_category."""
    data = _get_json("categories", {"display": "[id,id_parent,name,active]"})
    return data.get("categories", [])


@mcp.tool()
def list_tax_rules_groups() -> list[dict]:
    """Lista grupos de reglas de impuestos (p.ej. 'ES Standard Rate (21%)') para id_tax_rules_group."""
    data = _get_json("tax_rule_groups", {"display": "[id,name,active]"})
    return data.get("tax_rule_groups", [])


@mcp.tool()
def list_manufacturers() -> list[dict]:
    """Lista marcas/fabricantes (id, nombre)."""
    data = _get_json("manufacturers", {"display": "[id,name,active]"})
    return data.get("manufacturers", [])


@mcp.tool()
def find_product(reference: str = "", ean13: str = "", name_contains: str = "") -> list[dict]:
    """Busca productos por referencia exacta, EAN13 exacto o parte del nombre."""
    params = {"display": "[id,reference,ean13,name,active,price]"}
    if reference:
        params["filter[reference]"] = f"[{reference}]"
    if ean13:
        params["filter[ean13]"] = f"[{ean13}]"
    if name_contains:
        params["filter[name]"] = f"%[{name_contains}]%"
    return _get_json("products", params).get("products", [])


@mcp.tool()
def get_product(product_id: int) -> dict:
    """Devuelve el producto completo."""
    return _get_json(f"products/{product_id}").get("product", {})


@mcp.tool()
def create_product(
    name: str,
    price: float,
    id_category: int,
    reference: str,
    description_html: str = "",
    description_short_html: str = "",
    price_includes_tax: bool = True,
    vat_percent: float = 21.0,
    id_tax_rules_group: int = 0,
    id_manufacturer: int = 0,
    ean13: str = "",
    weight_kg: float = 0.0,
    quantity: int | None = None,
    active: bool = False,
    extra_category_ids: list[int] | None = None,
) -> dict:
    """Crea un producto. Por defecto queda DESACTIVADO para revisarlo antes de publicar.

    price: si price_includes_tax=True se convierte a precio sin IVA con vat_percent
    (PrestaShop guarda el precio neto). Falla si ya existe un producto con esa referencia.
    """
    existing = _find_by_reference(reference)
    if existing:
        raise RuntimeError(f"Ya existe producto con referencia {reference}: {existing}. Usa update_product.")
    clean = _clean_name(name)
    fields = {
        "id_manufacturer": id_manufacturer,
        "id_category_default": id_category,
        "id_tax_rules_group": id_tax_rules_group,
        "id_shop_default": 1,
        "reference": reference,
        "ean13": ean13,
        "weight": weight_kg,
        "price": _net_price(price, price_includes_tax, vat_percent),
        "active": int(active),
        "state": 1,
        "visibility": "both",
        "available_for_order": 1,
        "show_price": 1,
        "minimal_quantity": 1,
        "name": _multilang(clean),
        "link_rewrite": _multilang(_slugify(clean)),
        "description": _multilang(description_html),
        "description_short": _multilang(description_short_html),
    }
    category_ids = [id_category] + [c for c in (extra_category_ids or []) if c != id_category]
    assoc = "<categories>" + "".join(f"<category><id>{c}</id></category>" for c in category_ids) + "</categories>"
    product = _send_xml("POST", "products", _resource_xml("product", fields, assoc)).get("product", {})
    result = {"id": product.get("id"), "reference": reference, "active": active, "price_tax_excl": fields["price"]}
    if quantity is not None and product.get("id"):
        result["stock"] = set_stock(int(product["id"]), quantity)
    return result


@mcp.tool()
def update_product(product_id: int, changes: dict) -> dict:
    """Actualiza campos de un producto. changes = {campo: valor}.

    Campos multi-idioma (name, description, description_short, meta_title...) aceptan texto
    plano (se aplica a todos los idiomas) o {lang_id: texto}. Para precio con IVA usa
    'price_tax_incl' + opcional 'vat_percent' (21 por defecto).
    """
    current = _get_json(f"products/{product_id}").get("product")
    if not current:
        raise RuntimeError(f"Producto {product_id} no encontrado")
    multilang_fields = {k for k, v in current.items() if isinstance(v, list) and k != "associations"}
    changes = dict(changes)
    if "price_tax_incl" in changes:
        vat = float(changes.pop("vat_percent", 21.0))
        changes["price"] = _net_price(float(changes.pop("price_tax_incl")), True, vat)
    for key, value in changes.items():
        if key in multilang_fields and isinstance(value, str):
            value = _multilang(_clean_name(value) if key == "name" else value)
        current[key] = value
    fields = {k: v for k, v in current.items() if k not in READ_ONLY_PRODUCT_FIELDS}
    _send_xml("PUT", f"products/{product_id}", _resource_xml("product", fields))
    return {"id": product_id, "updated": sorted(changes)}


@mcp.tool()
def set_stock(product_id: int, quantity: int, id_product_attribute: int = 0) -> dict:
    """Fija el stock de un producto (o de una combinación con id_product_attribute)."""
    data = _get_json("stock_availables", {
        "filter[id_product]": f"[{product_id}]",
        "filter[id_product_attribute]": f"[{id_product_attribute}]",
        "display": "full",
    })
    rows = data.get("stock_availables", [])
    if not rows:
        raise RuntimeError(f"No hay stock_available para producto {product_id}/{id_product_attribute}")
    row = rows[0]
    row["quantity"] = quantity
    _send_xml("PUT", f"stock_availables/{row['id']}", _resource_xml("stock_available", row))
    return {"stock_available_id": row["id"], "quantity": quantity}


@mcp.tool()
def upload_images(product_id: int, sources: list[str]) -> list[dict]:
    """Sube imágenes al producto. sources = rutas locales o URLs http(s). La primera será la portada
    si el producto no tiene imágenes."""
    results = []
    for src in sources:
        try:
            if src.startswith(("http://", "https://")):
                r = requests.get(src, timeout=60)
                r.raise_for_status()
                results.append(_upload_image_bytes(product_id, Path(src.split("?")[0]).name, r.content))
            else:
                path = Path(src).expanduser()
                results.append(_upload_image_bytes(product_id, path.name, path.read_bytes()))
        except Exception as exc:  # keep going; report per-file failures
            results.append({"file": src, "error": str(exc)})
    return results


def _amazon_gallery_urls(image_urls: list[str]) -> list[str]:
    """Dedupe Amazon image variants and return full-resolution URLs, gallery (hi-res) images first."""
    seen: dict[str, bool] = {}
    for url in image_urls:
        m = re.search(r"/images/I/([^./]+)\.", url)
        if not m:
            continue
        img_id = m.group(1)
        is_hires = "_SL1" in url or "_SL2" in url
        seen[img_id] = seen.get(img_id, False) or is_hires
    hires = [i for i, h in seen.items() if h]
    chosen = hires or list(seen)
    return [f"https://m.media-amazon.com/images/I/{i}.jpg" for i in chosen]


@mcp.tool()
def import_from_scrapin(
    asin: str,
    price: float,
    id_category: int,
    reference: str = "",
    name_override: str = "",
    price_includes_tax: bool = True,
    vat_percent: float = 21.0,
    id_tax_rules_group: int = 0,
    id_manufacturer: int = 0,
    ean13: str = "",
    quantity: int | None = None,
    max_images: int = 9,
    dry_run: bool = True,
) -> dict:
    """Crea un producto a partir de scrap-in/<ASIN>/product-info.json (título, viñetas, imágenes).

    dry_run=True (defecto) solo devuelve el plan sin tocar la tienda. El producto se crea desactivado.
    reference por defecto = ASIN.
    """
    info_path = SCRAP_IN_DIR / asin / "product-info.json"
    if not info_path.exists():
        raise RuntimeError(f"No existe {info_path}. Ejecuta antes el Scrap In del ASIN.")
    info = json.loads(info_path.read_text())
    name = _clean_name(name_override or info.get("title") or asin)
    bullets = [b for b in (info.get("bullet_points") or []) if b]
    short_html = "<ul>" + "".join(f"<li>{escape(b)}</li>" for b in bullets[:3]) + "</ul>" if bullets else ""
    desc_parts = []
    if info.get("description"):
        desc_parts.append(f"<p>{escape(html.unescape(info['description']))}</p>")
    if bullets:
        desc_parts.append("<ul>" + "".join(f"<li>{escape(b)}</li>" for b in bullets) + "</ul>")
    images = _amazon_gallery_urls(info.get("images") or [])[:max_images]
    plan = {
        "name": name,
        "reference": reference or asin,
        "price_input": price,
        "price_tax_excl": _net_price(price, price_includes_tax, vat_percent),
        "id_category": id_category,
        "description_short_html": short_html,
        "description_html": "".join(desc_parts),
        "images": images,
        "active": False,
    }
    if dry_run:
        return {"dry_run": True, "plan": plan}
    created = create_product(
        name=name, price=price, id_category=id_category, reference=plan["reference"],
        description_html=plan["description_html"], description_short_html=short_html,
        price_includes_tax=price_includes_tax, vat_percent=vat_percent,
        id_tax_rules_group=id_tax_rules_group, id_manufacturer=id_manufacturer,
        ean13=ean13, quantity=quantity, active=False,
    )
    created["images"] = upload_images(int(created["id"]), images) if created.get("id") else []
    return created


if __name__ == "__main__":
    mcp.run()
