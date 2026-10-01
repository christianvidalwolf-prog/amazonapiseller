#!/usr/bin/env python3
"""
Envío de nuevas fichas técnicas a Cdiscount Marketplace (Octopia)
-----------------------------------------------------------------
Regla de oro (ver .claude/skills/cdiscount-product-creation): un paquete ACEPTADO
por la API NO es un producto creado. Sólo se da por creado un SKU cuando el
informe de integración (/products-integration-reports) lo confirma como Integrated.

Consecuencias en este script:
- Los rechazados (p. ej. QuotaExceeded) NO se marcan como enviados: van a
  `refused_skus` y se reintentan en la siguiente ejecución.
- Los que todavía no aparecen en el informe quedan en `pending_packages` para
  reconciliarlos en la siguiente ejecución (o con --reconcile-only).
- El informe se consulta SIEMPRE antes de tocar `submitted_skus`.

Lote por defecto: 25. Dos motivos medidos el 2026-10-01:
  1. El informe devuelve como máximo 25 items por paquete y no pagina
     (itemsPerPage=25; page/offset/limit/skip se ignoran, y pageSize da HTTP 400),
     así que con lotes de 25 la verificación es del 100%.
  2. La cuota real observada es de ~25 fichas por hora: ese día se enviaron 6
     lotes de ~50 en 28 s y a partir del segundo todos fueron QuotaExceeded.

Uso:
  python3 push_all_product_sheets.py                      # un lote de 25 y lo verifica
  python3 push_all_product_sheets.py --batch-limit 25
  python3 push_all_product_sheets.py --reconcile-only     # verifica pendientes, no sube nada
  python3 push_all_product_sheets.py --packages id1,id2   # repara paquetes concretos, no sube nada
"""

import argparse
import json
import os
import re
import time
from datetime import datetime

import requests

from amazon_fr_catalog import AmazonFRCatalog
from cdiscount_client import CdiscountClient

PROGRESS_FILE = "cdiscount_catalog_progress.json"
CACHE_FILE = "amz_fr_catalog_cache.json"
REPORT_URL = "https://api.octopia-io.net/seller/v2/products-integration-reports"
API_BASE = "https://api.octopia-io.net/seller/v2"
DEFAULT_BATCH_LIMIT = 25
REPORT_POLL_SECONDS = 15
REPORT_WAIT_SECONDS = 300

# Rechazos que merece la pena reintentar: son de cuota/transitorios y volverán a
# pasar cuando la cuota se libere. El resto (CategorizationError, ER400-7480, …)
# son errores de datos: reintentarlos sólo quemaría la cuota de ~25/hora, así que
# se guardan en `blocked_skus` para revisarlos a mano.
RETRYABLE_CODES = {"QuotaExceeded"}

# Cdiscount: 132 caracteres de título. `richMarketingDescription` admite 5000, pero
# el campo `description` no publica su tope; 1900 es holgado y suficiente.
TITLE_MAX = 132
DESCRIPTION_MAX = 1900

# Fichero opcional para forzar la categoría de un SKU concreto:
#   { "2139462CLM": "0E040K" }
# Cdiscount acepta `categoryCode` en el payload (components/schemas/Product del
# OpenAPI oficial); es la salida cuando el categorizador automático no valida.
CATEGORY_OVERRIDES_FILE = "cdiscount_category_overrides.json"

# Fichero opcional para reescribir el título de un SKU concreto:
#   { "2139462CLM": "Lot de 8 pailles à boisson en forme de cœur" }
# El título debe nombrar el TIPO DE PRODUCTO de la categoría: si no, Cdiscount no
# puede "validar que la categoría asociada sea adecuada" (CategorizationError) ni
# siquiera forzando el categoryCode. Marca y SKU se añaden solos al final.
TITLE_OVERRIDES_FILE = "cdiscount_title_overrides.json"

# Propiedades obligatorias que Cdiscount reclama con ER400-6067. El informe las
# devuelve en `field` (la referencia de propiedad) y el payload las espera como
#   attributes: [{propertyReference: "3263", values: ["Argenté"]}]
# (formato en components/schemas/Attribute del OpenAPI oficial).
ATTRIBUTE_COLOR = "3263"   # Couleur(s): texto libre
ATTRIBUTE_SIZE = "46830"   # Taille bijou: lista de valores; "Taille unique" es válida

COLORES_FR = [
    ("argent", "Argenté"), ("doré", "Doré"), ("dore", "Doré"), ("bleu", "Bleu"),
    ("noir", "Noir"), ("blanc", "Blanc"), ("rose", "Rose"), ("vert", "Vert"),
    ("rouge", "Rouge"), ("violet", "Violet"), ("mauve", "Mauve"), ("marron", "Marron"),
    ("gris", "Gris"), ("beige", "Beige"), ("turquoise", "Turquoise"),
    ("transparent", "Transparent"), ("multicolore", "Multicolore"),
]


def _guess_color(*texts) -> str:
    """Color en francés a partir del título/descripción (Amazon manda 'Modelo 1')."""
    low = " ".join(_clean(t).lower() for t in texts if t)
    mejor, posicion = "", len(low) + 1
    for needle, value in COLORES_FR:
        i = low.find(needle)
        if i != -1 and i < posicion:
            mejor, posicion = value, i
    return mejor or "Multicolore"


def load_category_overrides() -> dict:
    """Categorías forzadas por SKU (fichero opcional, editable a mano)."""
    return _load_json_map(CATEGORY_OVERRIDES_FILE, "categorías")


def load_title_overrides() -> dict:
    """Títulos reescritos por SKU (fichero opcional, editable a mano)."""
    return _load_json_map(TITLE_OVERRIDES_FILE, "títulos")


def _load_json_map(path: str, etiqueta: str) -> dict:
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return {str(k): str(v) for k, v in data.items()}
        except Exception as err:
            log(f"⚠️ No se pudo leer {path}: {err}")
    return {}


def _clean(value) -> str:
    """Quita HTML y colapsa espacios: Cdiscount no admite HTML en title/description."""
    import re

    text = str(value or "")
    text = re.sub(r"<[^>]+>", " ", text)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&quot;", '"')
    return re.sub(r"\s+", " ", text).strip()


def log(msg: str):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


# --------------------------------------------------------------------------- estado

def normalize_progress(data: dict) -> dict:
    """Compatibilidad con ficheros de progreso antiguos (sin refused/pending)."""
    data.setdefault("submitted_skus", [])
    data.setdefault("refused_skus", {})
    data.setdefault("blocked_skus", {})
    data.setdefault("variant_group_skus", [])
    data.setdefault("attribute_skus", {})
    data.setdefault("pending_packages", [])
    data.setdefault("total_submitted", len(data["submitted_skus"]))
    data.setdefault("last_run", None)
    return data


def load_progress() -> dict:
    if os.path.exists(PROGRESS_FILE):
        try:
            with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
                return normalize_progress(json.load(f))
        except Exception as err:
            log(f"⚠️ No se pudo leer {PROGRESS_FILE} ({err}); se empieza de cero.")
    return normalize_progress({})


def save_progress(progress: dict):
    progress["submitted_skus"] = sorted(set(progress["submitted_skus"]))
    progress["total_submitted"] = len(progress["submitted_skus"])
    progress["last_run"] = datetime.now().isoformat()
    with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
        json.dump(progress, f, indent=2, ensure_ascii=False)


# --------------------------------------------------------------------------- informes

def fetch_report(client: CdiscountClient, package_id: str):
    """Items del informe de integración de un paquete (máx. 25) o None si falla."""
    try:
        res = requests.get(REPORT_URL, headers=client.get_headers(),
                           params={"packageId": package_id}, timeout=30)
    except Exception as err:
        log(f"⚠️ No se pudo consultar el informe de {package_id}: {err}")
        return None
    if res.status_code != 200:
        log(f"⚠️ Informe de {package_id}: HTTP {res.status_code} {res.text[:120]}")
        return None
    return res.json().get("items", [])


def settle_items(items, submitted: set, refused: dict, blocked: dict, variant_group: set, attribute_skus: dict) -> dict:
    """El informe manda: Integrated = creado; el resto se clasifica para reintentar."""
    integrated, refused_now, blocked_now, variant_now, attribute_now = [], [], [], [], []
    for it in items:
        sku = it.get("sellerProductReference")
        if not sku:
            continue
        if it.get("status") == "Integrated":
            submitted.add(sku)
            refused.pop(sku, None)
            blocked.pop(sku, None)
            variant_group.discard(sku)
            attribute_skus.pop(sku, None)
            integrated.append(sku)
            continue

        submitted.discard(sku)
        errores = it.get("errors") or []
        codes = [e.get("code") for e in errores if e.get("code")]
        fields = [str(e.get("field") or "").lower() for e in errores]
        refs = sorted({str(e.get("field")) for e in errores if str(e.get("field") or "").isdigit()})
        motivo = ", ".join(codes) or str(it.get("status") or "Refused")

        if any("variantgroupreference" in f for f in fields):
            # Cdiscount pide la referencia de grupo de variantes: se reintenta CON ese
            # campo (por eso no va a `blocked`, que no se reintenta nunca).
            variant_group.add(sku)
            refused.pop(sku, None)
            blocked.pop(sku, None)
            variant_now.append(sku)
        elif "ER400-6067" in codes:
            # "L'attribut est requis": la categoría exige propiedades obligatorias.
            # Se guardan las referencias pedidas y se reintenta con `attributes`.
            if refs:
                attribute_skus[sku] = refs
                refused.pop(sku, None)
                blocked.pop(sku, None)
                attribute_now.append(sku)
            else:
                blocked[sku] = motivo
                refused.pop(sku, None)
                blocked_now.append(sku)
        elif any(code in RETRYABLE_CODES for code in codes):
            refused[sku] = motivo
            blocked.pop(sku, None)
            variant_group.discard(sku)
            refused_now.append(sku)
        else:
            blocked[sku] = motivo
            refused.pop(sku, None)
            variant_group.discard(sku)
            attribute_skus.pop(sku, None)
            blocked_now.append(sku)
    return {"integrated": integrated, "refused": refused_now, "blocked": blocked_now,
            "variant": variant_now, "attribute": attribute_now}


_VARIANT_CATEGORY_CACHE = {}


def category_is_variant(client: CdiscountClient, category_code: str) -> bool:
    """¿La categoría de Cdiscount es de variantes? (cacheado por ejecución)"""
    if not category_code:
        return False
    if category_code not in _VARIANT_CATEGORY_CACHE:
        try:
            res = requests.get(f"{API_BASE}/categories/{category_code}",
                               headers=client.get_headers(), timeout=25)
            _VARIANT_CATEGORY_CACHE[category_code] = bool(res.json().get("isVariant")) \
                if res.status_code == 200 else False
        except Exception:
            _VARIANT_CATEGORY_CACHE[category_code] = False
    return _VARIANT_CATEGORY_CACHE[category_code]


def mark_variant_attributes(client: CdiscountClient, items: list, result: dict, variant_group: set) -> list:
    """
    Si la categoría es de variantes, además de rellenar los atributos obligatorios hay
    que seguir enviando `variantGroupReference`: al reclamar atributos, Cdiscount ya no
    repite el error de variante, pero lo vuelve a exigir si dejas de mandarlo.
    """
    codes = {it.get("sellerProductReference"): it.get("categoryCode") for it in items}
    marcados = []
    for sku in result.get("attribute", []) or []:
        if category_is_variant(client, codes.get(sku)):
            variant_group.add(sku)
            marcados.append(sku)
    return marcados


def reconcile_packages(client: CdiscountClient, progress: dict, package_ids: list) -> dict:
    """Verifica paquetes ya enviados y repara el progreso. No sube nada."""
    submitted = set(progress["submitted_skus"])
    refused = dict(progress["refused_skus"])
    blocked = dict(progress["blocked_skus"])
    variant_group = set(progress["variant_group_skus"])
    attribute_skus = dict(progress["attribute_skus"])
    pending = list(progress["pending_packages"])
    totals = {"integrated": 0, "refused": 0, "blocked": 0, "variant": 0, "attribute": 0, "unseen": 0}

    for package_id in package_ids:
        entry = next((p for p in pending if p.get("packageId") == package_id), None)
        items = fetch_report(client, package_id)
        if items is None:
            continue
        result = settle_items(items, submitted, refused, blocked, variant_group, attribute_skus)
        marcados = mark_variant_attributes(client, items, result, variant_group)
        if marcados:
            log(f"     (categoría de variantes: también hay que enviar variantGroupReference -> {', '.join(marcados)})")
        totals["integrated"] += len(result["integrated"])
        totals["refused"] += len(result["refused"])
        totals["blocked"] += len(result["blocked"])
        totals["variant"] += len(result["variant"])
        totals["attribute"] += len(result["attribute"])

        # Lo que el informe no muestra sigue pendiente (el endpoint topa en 25 items).
        seen = {it.get("sellerProductReference") for it in items}
        expected = set(entry.get("skus", [])) if entry else set()
        unseen = sorted(expected - seen) if expected else []
        totals["unseen"] += len(unseen)

        log(f"  · {package_id[:8]}… informe={len(items)} items | "
            f"integrados={len(result['integrated'])} reintentables={len(result['refused'])} "
            f"bloqueados={len(result['blocked'])} variantes={len(result['variant'])} "
            f"atributos={len(result['attribute'])}"
            + (f" sin confirmar={len(unseen)}" if unseen else ""))

        pending = [p for p in pending if p.get("packageId") != package_id]
        if unseen:
            pending.append({"packageId": package_id, "skus": unseen,
                            "submittedAt": (entry or {}).get("submittedAt"),
                            "checkedAt": datetime.now().isoformat()})

    progress["submitted_skus"] = sorted(submitted)
    progress["refused_skus"] = refused
    progress["blocked_skus"] = blocked
    progress["variant_group_skus"] = sorted(variant_group)
    progress["attribute_skus"] = attribute_skus
    progress["pending_packages"] = pending
    return totals


# --------------------------------------------------------------------------- payload

def format_cdiscount_title(raw_title: str, brand: str, sku: str) -> str:
    """
    [Type of product] + [Brand] + [Model], pero SIN perder palabras.

    La versión anterior se quedaba con las 6 primeras palabras más 2 sueltas y
    recortaba a lo bruto, produciendo títulos que Cdiscount no puede categorizar:
      "Vidal Regalos Lot de 8 cannes à boisson en forme de cœur"
        -> "Lot de 8 cannes à boisson Vidal Regalos 2139462CLM en forme"  (perdía "de cœur")
      "Rocking Gifts Décoration de bureau sur socle Rosemary 15 x 23 cm"
        -> "Décoration de bureau sur socle Rosemary ROCKING GIFTS ... 15 x"  (perdía "23 cm")
    Ahora se conserva el texto descriptivo completo y sólo se recorta en frontera
    de palabra si no cabe en 132 caracteres.
    """
    import re

    brand_clean = (brand or "Generic").strip()
    if not raw_title:
        return f"Produit {brand_clean} {sku}".strip()[:TITLE_MAX]

    t = _clean(raw_title)

    # 1. Quitar la marca del principio (se vuelve a añadir delante del SKU)
    t = re.sub(rf"^{re.escape(brand_clean)}\s*[-–—:| ]\s*", "", t, flags=re.IGNORECASE).strip()

    # 2. Quitar el SKU si ya venía en el título (duplicado, con o sin separador)
    t = re.sub(rf"\s*[-–—:| ]\s*{re.escape(sku)}\b", "", t, flags=re.IGNORECASE)
    t = re.sub(rf"\b{re.escape(sku)}\b", "", t, flags=re.IGNORECASE).strip(" -–—:|,")

    suffix = f"{brand_clean} {sku}".strip()
    room = TITLE_MAX - len(suffix) - 1
    if len(t) > room:
        t = t[:room].rsplit(" ", 1)[0].rstrip(" -–—:,")
    return f"{t} {suffix}".strip() if t else suffix[:TITLE_MAX]


def build_description(title: str, amz_data: dict, include_amazon_category: bool = True) -> str:
    """
    Descripción con los elementos extra que Cdiscount exige para validar la categoría.

    Su error de CategorizationError dice literalmente que el título y la descripción
    "no son lo bastante explícitos" y pide más elementos. Antes la descripción era una
    copia exacta del título, así que no aportaba nada. Ahora se añaden:
      - product_description de Amazon FR (texto rico, en francés)
      - los bullet_point (viñetas de características, en francés)
      - la ruta de clasificación FR ("Catégorie : Pierres thérapeutiques > Bien-être")

    `include_amazon_category=False` cuando forzamos un `categoryCode`: si la descripción
    declara la categoría de Amazon y no coincide con la forzada, el validador la rechaza
    (la propia frase es la que "no permite validar que la categoría asociada sea adecuada").
    """
    parts = []
    rich = _clean(amz_data.get("description")) if amz_data else ""
    if rich:
        parts.append(rich)
    bullets = [b for b in ((amz_data or {}).get("bullets") or []) if b]
    if bullets:
        # Amazon antepone símbolos decorativos (☆, ◆, •) a las viñetas.
        limpios = [re.sub(r"^[\s☆★◇◆•·▪◦*\-–—]+", "", b).strip() for b in bullets]
        parts.append("\n".join(f"- {b}" for b in limpios if b))
    path = ((amz_data or {}).get("classification_path") or (amz_data or {}).get("classification")) \
        if include_amazon_category else None
    if path:
        parts.append(f"Catégorie : {path}")

    body = "\n\n".join(parts).strip()
    combined = f"{title}\n\n{body}" if (title and body) else (title or body)
    if len(combined) > DESCRIPTION_MAX:
        combined = combined[:DESCRIPTION_MAX].rsplit(" ", 1)[0]
    return combined


def _meaningful(value) -> str:
    """Valor de atributo utilizable (Amazon FR a veces manda 'Modelo 1' como color)."""
    cleaned = _clean(value)
    return "" if cleaned.lower() in {"modelo 1", "model 1", "model", "n/a", "na", "none", "-"} else cleaned


def _cache_is_current(entry) -> bool:
    """
    Las fichas cacheadas antes del enriquecimiento no traen clasificación: si se
    reutilizan, el producto se vuelve a enviar sin los elementos que Cdiscount pide
    para categorizar. Se consideran obsoletas y se vuelven a pedir a Amazon.
    """
    return isinstance(entry, dict) and "classification_path" in entry


def build_payload(amazon_cat, cache: dict, candidates: list, batch_limit: int,
                  variant_group_skus=None, attribute_skus=None, category_overrides=None,
                  title_overrides=None):
    """Payload de hasta `batch_limit` fichas con imagen válida (Cdiscount la exige)."""
    variant_group_skus = variant_group_skus or set()
    attribute_skus = attribute_skus or {}
    category_overrides = category_overrides or {}
    title_overrides = title_overrides or {}
    payload, sin_imagen = [], []
    for p in candidates:
        if len(payload) >= batch_limit:
            break
        asin = p.get("asin")
        amz_data = cache.get(asin) if asin else None
        if asin and not _cache_is_current(amz_data):
            amz_data = amazon_cat.fetch_product_details(asin)
            if amz_data:
                cache[asin] = amz_data
            time.sleep(0.1)

        raw_title = title_overrides.get(p["sku"]) or (amz_data or {}).get("title") or p.get("title")
        brand = (amz_data or {}).get("brand") or "Generic"
        image = (amz_data or {}).get("image")

        if not image:
            sin_imagen.append(p["sku"])
            continue

        title = format_cdiscount_title(raw_title, brand, p["sku"])
        category_code = category_overrides.get(p["sku"])
        item = {
            "gtin": p["ean"],
            "sellerProductReference": p["sku"],
            "title": title,
            "brand": brand,
            # Si forzamos categoría, no se añade la de Amazon: contradecirla la invalida.
            "description": build_description(title, amz_data or {}, include_amazon_category=not category_code),
            "sellerPictureUrls": [{"index": 1, "url": image}],
        }

        # Sólo se envía cuando el informe de Cdiscount lo ha exigido para ese SKU:
        # en una categoría que no es de variantes, enviarlo también hace fallar la ficha.
        if p["sku"] in variant_group_skus:
            item["variantGroupReference"] = asin or p["sku"]
            color = _meaningful((amz_data or {}).get("color"))
            size = _meaningful((amz_data or {}).get("size"))
            if color:
                item["color"] = color
            if size:
                item["size"] = size

        # Categoría forzada (cuando el categorizador automático no valida la suya).
        if category_code:
            item["categoryCode"] = category_code

        # Propiedades obligatorias de la categoría que reclamó el informe (ER400-6067).
        refs = attribute_skus.get(p["sku"]) or []
        if refs:
            attributes = []
            for ref in refs:
                if ref == ATTRIBUTE_COLOR:
                    attributes.append({"propertyReference": ref, "values": [
                        _guess_color(raw_title, (amz_data or {}).get("color"),
                                     (amz_data or {}).get("description"))
                    ]})
                elif ref == ATTRIBUTE_SIZE:
                    attributes.append({"propertyReference": ref, "values": [
                        _meaningful((amz_data or {}).get("size")) or "Taille unique"
                    ]})
                else:
                    log(f"   ⚠️ {p['sku']}: la categoría exige la propiedad {ref} y no hay valor automático; se omite")
            if attributes:
                item["attributes"] = attributes

        payload.append(item)
    return payload, sin_imagen


def verify_upload(client: CdiscountClient, package_id: str, skus: set, wait_seconds: int) -> list:
    """Espera a que el informe liste los SKU enviados y devuelve los items vistos."""
    deadline = time.time() + wait_seconds
    seen = {}
    while True:
        for it in fetch_report(client, package_id) or []:
            sku = it.get("sellerProductReference")
            if sku in skus:
                seen[sku] = it
        if len(seen) >= len(skus) or time.time() >= deadline:
            return list(seen.values())
        time.sleep(REPORT_POLL_SECONDS)


# --------------------------------------------------------------------------- ejecución

def main():
    parser = argparse.ArgumentParser(description="Envío verificado de fichas a Cdiscount (Octopia).")
    parser.add_argument("--batch-limit", type=int, default=DEFAULT_BATCH_LIMIT,
                        help=f"Fichas por ejecución (por defecto {DEFAULT_BATCH_LIMIT}: tope del informe y cuota horaria observada)")
    parser.add_argument("--reconcile-only", action="store_true",
                        help="Sólo verifica los paquetes pendientes y repara el progreso; no sube nada")
    parser.add_argument("--packages", help="IDs de paquete separados por comas: los verifica y repara el progreso sin subir nada")
    parser.add_argument("--only-skus", help="Crea sólo estos SKU (separados por comas), ignorando el orden del catálogo")
    parser.add_argument("--verify-wait", type=int, default=REPORT_WAIT_SECONDS,
                        help=f"Segundos máximos a esperar el informe de integración (por defecto {REPORT_WAIT_SECONDS})")
    args = parser.parse_args()

    client = CdiscountClient()
    progress = load_progress()
    submitted = set(progress["submitted_skus"])
    refused = dict(progress["refused_skus"])
    blocked = dict(progress["blocked_skus"])
    variant_group = set(progress["variant_group_skus"])
    attribute_skus = dict(progress["attribute_skus"])
    category_overrides = load_category_overrides()
    title_overrides = load_title_overrides()
    log("=" * 70)
    log(" CDISCOUNT · fichas de producto (envío verificado)")
    log(f" Integrados: {len(submitted)} | reintentables: {len(refused)} | bloqueados: {len(blocked)} | "
        f"grupo de variantes: {len(variant_group)} | atributos obligatorios: {len(attribute_skus)} | "
        f"categorías forzadas: {len(category_overrides)} | títulos reescritos: {len(title_overrides)}")
    log("=" * 70)

    # Modo reparación: verificar paquetes concretos o los pendientes. No sube nada.
    if args.packages or args.reconcile_only:
        ids = [p.strip() for p in args.packages.split(",")] if args.packages else \
              [p["packageId"] for p in progress["pending_packages"]]
        if not ids:
            log("Nada que reconciliar.")
            return
        log(f"🔎 Reconciliando {len(ids)} paquete(s) con el informe de integración…")
        totals = reconcile_packages(client, progress, ids)
        save_progress(progress)
        log(f"✅ Integrados ahora: {totals['integrated']} | reintentables: {totals['refused']} "
            f"| bloqueados: {totals['blocked']} | variantes: {totals['variant']} "
            f"| atributos: {totals['attribute']} | siguen sin confirmar: {totals['unseen']}")
        log(f"📊 Progreso: {len(progress['submitted_skus'])} integrados, "
            f"{len(progress['refused_skus'])} reintentables, {len(progress['blocked_skus'])} bloqueados, "
            f"{len(progress['variant_group_skus'])} con grupo de variantes, "
            f"{len(progress['attribute_skus'])} con atributos obligatorios")
        if progress["variant_group_skus"]:
            log("🧩 Necesitan variantGroupReference (se reintentarán con ese campo): "
                + ", ".join(progress["variant_group_skus"][:8]))
        if progress["attribute_skus"]:
            log("🧷 Necesitan propiedades obligatorias y ya se rellenan solas: "
                + "; ".join(f"{s} -> {r}" for s, r in list(progress["attribute_skus"].items())[:5]))
        if progress["blocked_skus"]:
            muestra = list(progress["blocked_skus"].items())[:5]
            log("🛠️  Bloqueados (no se reintentan; hay que corregir el dato): "
                + "; ".join(f"{s} [{m}]" for s, m in muestra))
        return

    # Camino normal: preparar lote.
    amazon_cat = AmazonFRCatalog()
    all_missing = amazon_cat.get_missing_products_from_csv()

    if args.only_skus:
        objetivo = [s.strip() for s in args.only_skus.split(",") if s.strip()]
        por_sku = {p["sku"]: p for p in all_missing}
        candidates = [por_sku[s] for s in objetivo if s in por_sku]
        faltan = [s for s in objetivo if s not in por_sku]
        if faltan:
            log(f"⚠️ No están en el catálogo de pendientes: {faltan}")
        log(f"🎯 Modo --only-skus: {len(candidates)} fichas seleccionadas a mano")
    else:
        reintentos = [p for p in all_missing if p["sku"] in refused]
        variantes = [p for p in all_missing if p["sku"] in variant_group]
        con_atributos = [p for p in all_missing if p["sku"] in attribute_skus]
        ya_clasificados = refused.keys() | variant_group | blocked.keys() | attribute_skus.keys()
        nuevos = [p for p in all_missing if p["sku"] not in submitted and p["sku"] not in ya_clasificados]
        log(f"📋 Candidatos: {len(reintentos)} reintentos + {len(variantes)} de grupo de variantes + "
            f"{len(con_atributos)} con atributos obligatorios + {len(nuevos)} nuevos "
            f"(de {len(all_missing)}; se omiten {len(blocked)} bloqueados)")
        candidates = reintentos + variantes + con_atributos + nuevos

    if not candidates:
        log("🎉 Nada pendiente por enviar.")
        return

    batch_limit = len(candidates) if args.only_skus else args.batch_limit

    cache = {}
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                cache = json.load(f)
        except Exception:
            cache = {}

    payload, sin_imagen = build_payload(amazon_cat, cache, candidates, batch_limit,
                                        variant_group, attribute_skus, category_overrides, title_overrides)
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    if sin_imagen:
        log(f"⏭️  {len(sin_imagen)} sin imagen válida (Cdiscount la exige), se saltan: {sin_imagen[:5]}…"
            if len(sin_imagen) > 5 else f"⏭️  Sin imagen válida: {sin_imagen}")
    if not payload:
        log("⚠️ No se encontraron productos pendientes con imagen válida.")
        return

    log(f"📤 Subiendo paquete con {len(payload)} fichas…")
    package_id = client.create_products(payload)
    if not package_id:
        log("❌ La API no devolvió packageId: NO se marca nada como enviado.")
        save_progress(progress)
        return

    skus = {p["sellerProductReference"] for p in payload}
    log(f"📦 Paquete subido: {package_id}")
    log(f"🔎 Verificando integración (máx. {args.verify_wait}s) — subir el paquete no es crear el producto…")
    items = verify_upload(client, package_id, skus, args.verify_wait)
    result = settle_items(items, submitted, refused, blocked, variant_group, attribute_skus)
    mark_variant_attributes(client, items, result, variant_group)

    vistos = {it.get("sellerProductReference") for it in items}
    unseen = sorted(skus - vistos)
    progress["submitted_skus"] = sorted(submitted)
    progress["refused_skus"] = refused
    progress["blocked_skus"] = blocked
    progress["variant_group_skus"] = sorted(variant_group)
    progress["attribute_skus"] = attribute_skus
    if unseen:
        progress["pending_packages"].append({
            "packageId": package_id, "skus": unseen,
            "submittedAt": datetime.now().isoformat(),
        })
    progress["last_package_id"] = package_id
    save_progress(progress)

    log("-" * 70)
    log(f"✅ Integrados confirmados: {len(result['integrated'])}")
    log(f"🔁 Reintentables (cuota/transitorio): {len(result['refused'])}")
    log(f"🧩 Necesitan variantGroupReference (se reintentarán con ese campo): {len(result['variant'])}")
    log(f"🧷 Necesitan propiedades obligatorias (se reintentarán con `attributes`): {len(result['attribute'])}")
    log(f"🛠️  Bloqueados (error de dato, no se reintentan): {len(result['blocked'])}")
    if any("QuotaExceeded" in (refused.get(sku) or "") for sku in result["refused"]):
        log("⏳ Cuota agotada: espera ~1 hora antes del siguiente lote.")
    if unseen:
        log(f"❓ Sin confirmar todavía (guardados en pending_packages): {len(unseen)}")
    log(f"📊 Progreso: {len(submitted)} integrados de {len(all_missing)} | "
        f"reintentables: {len(refused)} | bloqueados: {len(blocked)} | variantes: {len(variant_group)} | "
        f"atributos: {len(attribute_skus)}")


if __name__ == "__main__":
    main()
