# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp>=1.2,<2", "requests>=2.31", "pillow>=10"]
# ///
"""Alta masiva en PrestaShop (vidalregals.com) de products.json, reutilizando el cliente del MCP.

Uso:
  uv run load_prestashop.py --check                 # compara con la tienda, no escribe
  uv run load_prestashop.py --limit 20              # piloto: crea los 20 primeros pendientes
  uv run load_prestashop.py --workers 4             # resto, reanudable
  uv run load_prestashop.py --retry-images          # reintenta imágenes fallidas (image_errors.json)
  uv run load_prestashop.py --activate              # activa los creados (activation.jsonl, reanudable)

Productos creados DESACTIVADOS. Textos solo en español (copiados a todos los idiomas, como el MCP).
Precio = precio actual Amazon ES de STOCK AMZ.csv (fallback: precio del alta). Stock = STOCK AMZ.csv.
Progreso en progress.jsonl: relanzar salta lo ya creado.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent.parent / "data"
STOCK_CSV = Path.home() / "Stock" / "STOCK AMZ.csv"
PRODUCTS = HERE / os.getenv("PS_PRODUCTS", "products.json")  # products_amazon_es.json: altas desde Amazon ES
PROGRESS = HERE / "progress.jsonl"
NO_ACTIVATE = HERE / "no_activar.txt"  # referencias creadas que no se deben activar (una por línea)
MAX_QTY = 99  # tope de stock en la web (Amazon muestra stocks de dropshipping de miles)
ID_TAX_RULES_GROUP = 1  # ES Standard rate (21%)
VAT = 21.0


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import mcp_server as ps  # noqa: E402  (lee PS_URL/PS_API_KEY del .env del proyecto al importar)


def load_stock() -> dict[str, tuple[int, float | None]]:
    lines = STOCK_CSV.read_text(encoding="utf-8-sig").splitlines()
    attrs = lines[4].split("\t")
    iq = attrs.index("fulfillment_availability#1.quantity")
    ip = next(i for i, a in enumerate(attrs)
              if "A1RKKUPIHCS9HS" in a and "our_price" in a and a.endswith("value_with_tax"))
    num = lambda v: float(v.replace(",", ".")) if v.strip() else None  # noqa: E731
    out = {}
    for line in lines[6:]:
        c = line.split("\t")
        if c[0].strip():
            out[c[0].strip()] = (int(num(c[iq]) or 0), num(c[ip]))
    return out


def existing_products() -> tuple[dict[str, int], dict[str, int]]:
    rows, offset, page = [], 0, 1000
    while True:  # paginado: la consulta completa supera el timeout del hosting
        batch = ps._get_json("products", {"display": "[id,reference,ean13]", "limit": f"{offset},{page}",
                                          "sort": "[id_ASC]"}).get("products", [])
        rows += batch
        if len(batch) < page:
            break
        offset += page
    (HERE / "shop_products_index.json").write_text(json.dumps(rows))
    by_ref, by_ean = {}, {}
    for p in rows:
        if p.get("reference"):
            by_ref[p["reference"]] = int(p["id"])
        if p.get("ean13"):
            by_ean[p["ean13"]] = int(p["id"])
    return by_ref, by_ean


SAME_PRODUCT_SUFFIXES = {5: {"DC", "CLM"}, 8: {"SG", "SGRG"}}


def possible_duplicates(products: list[dict], shop_refs: dict[str, int]) -> dict[str, list[str]]:
    """Mismo código numérico de proveedor ya dado de alta con el sufijo habitual de esa marca."""
    by_num: dict[str, list[str]] = {}
    for ref in shop_refs:
        m = re.match(r"^0*([0-9]+)([A-Za-z]*)$", ref)
        if m:
            by_num.setdefault(m.group(1), []).append(ref)
    out = {}
    for p in products:
        m = re.match(r"^0*([0-9]+)", p["reference"])
        if not m:
            continue
        num = m.group(1)
        suffixes = SAME_PRODUCT_SUFFIXES.get(p["id_manufacturer"], set())
        hits = [r for r in by_num.get(num, []) if re.sub(r"^[0-9]+", "", r) in suffixes]
        if hits:
            out[p["reference"]] = hits
    return out


def done_refs() -> set[str]:
    if not PROGRESS.exists():
        return set()
    return {r["reference"] for r in map(json.loads, PROGRESS.read_text().splitlines()) if r.get("status") == "created"}


def html_description(p: dict) -> str:
    parts = [f"<p>{escape(p['description'])}</p>"] if p["description"] else []
    if p["bullets"]:
        parts.append("<ul>" + "".join(f"<li>{escape(b)}</li>" for b in p["bullets"]) + "</ul>")
    return "".join(parts)


def valid_ean(ean: str) -> str:
    return ean if len(ean) == 13 and ean.isdigit() else ""


_log_lock = threading.Lock()


def log(entry: dict) -> None:
    with _log_lock, PROGRESS.open("a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def create_one(p: dict, stock: dict) -> dict:
    qty, amz_price = stock.get(p["reference"], (p.get("quantity") or 0, None))
    qty = min(qty, MAX_QTY)
    price = amz_price or p["price_es"]
    entry = {"reference": p["reference"], "price": price, "quantity": qty, "ts": time.strftime("%Y-%m-%d %H:%M:%S")}
    try:
        created = ps.create_product(
            name=p["name"], price=price, id_category=p["id_category"], reference=p["reference"],
            description_html=html_description(p),
            description_short_html=f"<p>{escape(p['subtitle'])}</p>" if p["subtitle"] else "",
            price_includes_tax=True, vat_percent=VAT, id_tax_rules_group=ID_TAX_RULES_GROUP,
            id_manufacturer=p["id_manufacturer"], ean13=valid_ean(p["ean13"]),
            weight_kg=p["weight_kg"] or 0, quantity=qty, active=False,
            extra_category_ids=p["extra_category_ids"],
        )
        entry["id"] = created.get("id")
        images = ps.upload_images(int(created["id"]), p.get("images") or [p["image"]]) if p["image"] else []
        entry["image_errors"] = [i for i in images if "error" in i]
        entry["status"] = "created"
    except Exception as exc:  # seguimos con el resto; queda registrado para reintentar
        entry["status"] = "error"
        entry["error"] = str(exc)[:500]
    log(entry)
    return entry


MAX_IMAGE_BYTES = 2_900_000  # límite de la tienda: 3000 KB


def fetch_image(url: str) -> bytes:
    """Descarga con reintentos; prueba la variante .JPG (Dcasa sirve algunas en mayúsculas)."""
    import requests
    variants = [url] + ([url[:-4] + ".JPG"] if url.endswith(".jpg") else [])
    last = None
    for attempt in range(4):
        for u in variants:
            try:
                r = requests.get(u, timeout=60)
                if r.status_code == 404:
                    last = RuntimeError(f"404 {u}")
                    continue
                r.raise_for_status()
                return r.content
            except Exception as exc:
                last = exc
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(str(last)[:300])


def shrink(content: bytes) -> bytes:
    from PIL import Image
    if len(content) <= MAX_IMAGE_BYTES:
        return content
    img = Image.open(io.BytesIO(content)).convert("RGB")
    img.thumbnail((2000, 2000))
    for quality in (90, 85, 80, 70, 60):
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=quality, optimize=True)
        if buf.tell() <= MAX_IMAGE_BYTES:
            return buf.getvalue()
    return buf.getvalue()


def retry_images(workers: int) -> None:
    path = HERE / "image_errors.json"
    items = json.loads(path.read_text())

    def one(it: dict) -> dict:
        pid = int(it["id"])
        try:
            current = ps._get_json("products", {"filter[id]": f"[{pid}]", "display": "[id,id_default_image]"}).get("products", [{}])[0]
            if str(current.get("id_default_image") or "0") not in ("0", ""):
                return {**it, "status": "ya_tenia"}
            content = shrink(fetch_image(it["url"]))
            ps._upload_image_bytes(pid, it["url"].rsplit("/", 1)[-1], content)
            return {**it, "status": "ok"}
        except Exception as exc:
            return {**it, "status": "error", "error": str(exc)[:300]}

    results = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for n, res in enumerate(as_completed([pool.submit(one, it) for it in items]), 1):
            results.append(res.result())
            if n % 25 == 0 or n == len(items):
                c = {s: sum(r["status"] == s for r in results) for s in ("ok", "ya_tenia", "error")}
                print(f"[{n}/{len(items)}] {c}", flush=True)
    still = [r for r in results if r["status"] == "error"]
    path.write_text(json.dumps(still, ensure_ascii=False, indent=1))
    print(f"pendientes tras reintento: {len(still)} (guardados en image_errors.json)")


ACTIVATION = HERE / "activation.jsonl"


def activate(workers: int, limit: int, refs: str) -> None:
    created = {}
    for line in PROGRESS.read_text().splitlines():
        r = json.loads(line)
        if r.get("status") == "created":
            created[r["reference"]] = int(r["id"])
    done = set()
    if ACTIVATION.exists():
        done = {r["reference"] for r in map(json.loads, ACTIVATION.read_text().splitlines()) if r["status"] == "ok"}
    skip = set(NO_ACTIVATE.read_text().split()) if NO_ACTIVATE.exists() else set()
    todo = [(ref, pid) for ref, pid in created.items() if ref not in done and ref not in skip]
    if refs:
        todo = [t for t in todo if t[0] in set(refs.split(","))]
    if limit:
        todo = todo[:limit]
    print(f"creados: {len(created)} | ya activados: {len(done)} | a activar ahora: {len(todo)}", flush=True)

    def one(ref: str, pid: int) -> dict:
        entry = {"reference": ref, "id": pid, "ts": time.strftime("%Y-%m-%d %H:%M:%S")}
        try:
            ps.update_product(pid, {"active": 1})
            entry["status"] = "ok"
        except Exception as exc:
            entry["status"] = "error"
            entry["error"] = str(exc)[:500]
        with _log_lock, ACTIVATION.open("a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return entry

    ok = err = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for n, fut in enumerate(as_completed([pool.submit(one, r, p) for r, p in todo]), 1):
            e = fut.result()
            ok += e["status"] == "ok"
            err += e["status"] == "error"
            if e["status"] == "error" or n % 100 == 0 or n == len(todo):
                print(f"[{n}/{len(todo)}] ok={ok} err={err} {e.get('error', '')[:150]}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="solo compara con la tienda")
    ap.add_argument("--retry-images", action="store_true", help="reintenta las imágenes de image_errors.json")
    ap.add_argument("--activate", action="store_true", help="activa los productos creados")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--include-duplicates", action="store_true", help="crear también los posibles duplicados")
    ap.add_argument("--refs", default="", help="lista de referencias separadas por coma")
    args = ap.parse_args()
    if args.activate:
        activate(args.workers, args.limit, args.refs)
        return
    if args.retry_images:
        retry_images(args.workers)
        return

    products = json.loads(PRODUCTS.read_text())
    stock = load_stock()
    by_ref, by_ean = existing_products()
    already = done_refs()

    in_shop = [p["reference"] for p in products if p["reference"] in by_ref]
    ean_clash = [p["reference"] for p in products if p["reference"] not in by_ref and p["ean13"] in by_ean]
    dups = possible_duplicates(products, by_ref)
    (HERE / "possible_duplicates.json").write_text(json.dumps(dups, indent=1))
    skip = set(ean_clash) | (set() if args.include_duplicates else set(dups))
    pending = [p for p in products
               if p["reference"] not in by_ref and p["reference"] not in already and p["reference"] not in skip]
    if args.refs:
        wanted = set(args.refs.split(","))
        pending = [p for p in pending if p["reference"] in wanted]
    if args.limit:
        pending = pending[: args.limit]

    print(f"tienda: {len(by_ref)} productos | ya existen por referencia: {len(in_shop)} | "
          f"EAN ya usado por otra referencia: {len(ean_clash)} | posibles duplicados (excluidos salvo "
          f"--include-duplicates): {len(dups)} | ya creados antes: {len(already)} | a crear ahora: {len(pending)}")
    if args.check:
        (HERE / "check_existing.json").write_text(json.dumps({"in_shop": in_shop, "ean_clash": ean_clash}, indent=1))
        return

    ok = err = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(create_one, p, stock) for p in pending]
        for n, fut in enumerate(as_completed(futures), 1):
            e = fut.result()
            ok += e["status"] == "created"
            err += e["status"] == "error"
            if e["status"] == "error" or n % 25 == 0 or n == len(pending):
                print(f"[{n}/{len(pending)}] ok={ok} err={err} último={e['reference']} {e.get('error', '')[:150]}", flush=True)


if __name__ == "__main__":
    main()
