#!/usr/bin/env python3
"""
Sincronizador y Creador Masivo de Listings para Amazon Italia (IT) y Francia (FR).

Localiza los productos de Signes Grimalt (*SGI) y Dcasa (*DCI / *DC) dados de alta en España
que aún no existen o no tienen oferta activa en Italia y/o Francia.
Extrae la ficha técnica completa de España (EAN, dimensiones, imágenes, marca, etc.) y genera
automáticamente el alta mediante la API de Listings Items (PUT):
  - Italia (IT):  PVP España + 7.00 EUR
  - Francia (FR): PVP España + 6.00 EUR
"""

import os
import sys
import time
import json
import argparse
from datetime import datetime
from typing import Optional, Dict, Any, List

import requests
import pandas as pd
from auth import get_access_token, get_base_url

SELLER_ID = os.getenv("SP_API_SELLER_ID", "A3RY0L9OY3TPHI").strip()
STOCK_DIR = "/Users/christianvidalwolf/Stock"

TARGET_MARKETPLACES = {
    "IT": {
        "id": "APJ6JRA9NG5V4",
        "name": "Italia",
        "locale": "it_IT",
        "flag": "🇮🇹",
        "price_offset": 7.0,
    },
    "FR": {
        "id": "A13V1IB3VIYZZH",
        "name": "Francia",
        "locale": "fr_FR",
        "flag": "🇫🇷",
        "price_offset": 6.0,
    },
}

SPAIN_MARKETPLACE_ID = "A1RKKUPIHCS9HS"


def log(msg: str):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {msg}", flush=True)


def load_target_skus() -> List[str]:
    """Carga los SKUs de Signes Grimalt y Dcasa dados de alta recientemente."""
    skus = set()

    # 1. Signes Grimalt
    f_signes = os.path.join(STOCK_DIR, "signes_pendientes_alta_amazon.xlsx")
    if os.path.exists(f_signes):
        try:
            df_s = pd.read_excel(f_signes)
            for val in df_s["Codigo_Signes"].dropna():
                clean = str(val).strip().replace("SG-", "")
                if clean:
                    skus.add(f"{clean}SGI")
        except Exception as e:
            log(f"⚠️ Error al leer {f_signes}: {e}")

    # 2. Dcasa
    f_dcasa = os.path.join(STOCK_DIR, "dcasa_pendientes_alta_amazon.xlsx")
    if os.path.exists(f_dcasa):
        try:
            df_d = pd.read_excel(f_dcasa)
            for val in df_d["CODIGO"].dropna():
                clean = str(val).strip()
                if clean:
                    skus.add(f"{clean}DCI")
        except Exception as e:
            log(f"⚠️ Error al leer {f_dcasa}: {e}")

    # 3. Fallback: STOCK AMZ.csv
    f_stock = os.path.join(STOCK_DIR, "STOCK AMZ.csv")
    if os.path.exists(f_stock):
        with open(f_stock, "r", encoding="utf-8-sig", errors="replace") as f:
            for line in f:
                parts = line.split("\t")
                if parts:
                    s = parts[0].strip()
                    if s.endswith("SGI") or s.endswith("DCI"):
                        skus.add(s)

    res = sorted(list(skus))
    log(f"📋 Total SKUs candidatos cargados: {len(res):,}")
    return res


def get_spanish_listing(token: str, base_url: str, sku: str) -> Optional[Dict[str, Any]]:
    """Obtiene los atributos y tipo de producto de España."""
    url = f"{base_url}/listings/2021-08-01/items/{SELLER_ID}/{sku}?marketplaceIds={SPAIN_MARKETPLACE_ID}&includedData=summaries,attributes"
    try:
        res = requests.get(url, headers={"x-amz-access-token": token}, timeout=15)
        if res.status_code == 200:
            return res.json()
    except Exception:
        pass
    return None


def check_marketplace_listing(token: str, base_url: str, sku: str, marketplace_id: str) -> bool:
    """Comprueba si el SKU ya existe y tiene ASIN en el marketplace de destino."""
    url = f"{base_url}/listings/2021-08-01/items/{SELLER_ID}/{sku}?marketplaceIds={marketplace_id}&includedData=summaries"
    try:
        res = requests.get(url, headers={"x-amz-access-token": token}, timeout=15)
        if res.status_code == 200:
            sums = res.json().get("summaries", [])
            if sums and sums[0].get("asin"):
                return True
    except Exception:
        pass
    return False


SCHEMA_CACHE: Dict[str, Any] = {}


def get_product_schema(token: str, base_url: str, product_type: str, marketplace_id: str) -> Optional[Dict[str, Any]]:
    """Obtiene el JSON Schema oficial para el tipo de producto en el marketplace indicado."""
    cache_key = f"{product_type}_{marketplace_id}"
    if cache_key in SCHEMA_CACHE:
        return SCHEMA_CACHE[cache_key]
    url = f"{base_url}/definitions/2020-09-01/productTypes/{product_type}?marketplaceIds={marketplace_id}&sellerId={SELLER_ID}&requirements=LISTING"
    try:
        res = requests.get(url, headers={"x-amz-access-token": token}, timeout=15)
        if res.status_code == 200:
            link = res.json().get("schema", {}).get("link", {}).get("resource")
            if link:
                s_res = requests.get(link, timeout=15)
                if s_res.status_code == 200:
                    schema_data = s_res.json()
                    SCHEMA_CACHE[cache_key] = schema_data
                    return schema_data
    except Exception:
        pass
    return None


import urllib.request
import urllib.parse

TRANSLATION_CACHE_FILE = "translations_cache.json"
TRANSLATION_CACHE = {}

if os.path.exists(TRANSLATION_CACHE_FILE):
    try:
        with open(TRANSLATION_CACHE_FILE, "r", encoding="utf-8") as f:
            TRANSLATION_CACHE = json.load(f)
    except Exception:
        TRANSLATION_CACHE = {}


def save_trans_cache():
    try:
        with open(TRANSLATION_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(TRANSLATION_CACHE, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def translate_text(text: str, target_lang: str) -> str:
    """Traduce texto de español al idioma destino con caché persistente."""
    if not text or not str(text).strip():
        return text
    clean_text = str(text).strip()
    cache_key = f"{target_lang}:{clean_text}"
    if cache_key in TRANSLATION_CACHE:
        return TRANSLATION_CACHE[cache_key]

    for attempt in range(3):
        try:
            url = (
                f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=es&tl={target_lang}&dt=t&q="
                + urllib.parse.quote(clean_text)
            )
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
                },
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                translated = "".join(part[0] for part in data[0] if part and part[0])
                if translated:
                    TRANSLATION_CACHE[cache_key] = translated
                    return translated
        except Exception:
            time.sleep(1 + attempt)

    return clean_text


def build_target_attributes(
    token: str,
    base_url: str,
    attrs_es: Dict[str, Any],
    product_type: str,
    target_mp_id: str,
    lang_tag: str,
    offset: float
) -> Dict[str, Any]:
    """Clona y adapta los atributos de España traduciendo los textos al idioma local y consultando el esquema dinámico."""
    target_attrs: Dict[str, Any] = {}

    ignored_keys = {
        "purchasable_offer",
        "merchant_shipping_group",
        "recommended_browse_nodes",
    }

    target_lang = "it" if "it" in lang_tag.lower() else "fr"

    for k, val_list in attrs_es.items():
        if k in ignored_keys:
            continue
        new_list = []
        for entry in val_list:
            item = dict(entry)
            item["marketplace_id"] = target_mp_id
            if "language_tag" in item:
                item["language_tag"] = lang_tag
            # Traducir campos de texto descriptivos
            if k in ("item_name", "bullet_point", "product_description") and "value" in item:
                item["value"] = translate_text(str(item["value"]), target_lang)
            new_list.append(item)
        target_attrs[k] = new_list

    # Calcular precio
    base_price = 20.0
    po_list = attrs_es.get("purchasable_offer", [])
    if po_list and po_list[0].get("our_price"):
        try:
            base_price = float(po_list[0]["our_price"][0]["schedule"][0]["value_with_tax"])
        except Exception:
            pass

    target_price = round(base_price + offset, 2)
    min_p = round(target_price * 0.5, 2)
    max_p = round(target_price * 2.0, 2)

    target_attrs["purchasable_offer"] = [{
        "currency": "EUR",
        "audience": "ALL",
        "marketplace_id": target_mp_id,
        "our_price": [{"schedule": [{"value_with_tax": target_price}]}],
        "minimum_seller_allowed_price": [{"schedule": [{"value_with_tax": min_p}]}],
        "maximum_seller_allowed_price": [{"schedule": [{"value_with_tax": max_p}]}],
    }]

    # Stock
    qty = 0
    fa_list = attrs_es.get("fulfillment_availability", [])
    if fa_list:
        qty = int(fa_list[0].get("quantity", 0))

    target_attrs["fulfillment_availability"] = [{
        "fulfillment_channel_code": "DEFAULT",
        "quantity": qty,
        "lead_time_to_ship_max_days": 2,
    }]

    # Merchant shipping group obligatorio para FBM
    target_attrs["merchant_shipping_group"] = [{"value": "legacy-template-id", "marketplace_id": target_mp_id}]

    # Consultar propiedades permitidas en el esquema de destino
    schema = get_product_schema(token, base_url, product_type, target_mp_id)
    allowed_props = schema.get("properties", {}) if schema else {}

    # Adaptación inteligente de dimensiones
    dwh = attrs_es.get("item_depth_width_height")
    lwh = attrs_es.get("item_length_width_height")

    # Extraer valores base si existen
    raw_dim = None
    if dwh and len(dwh) > 0:
        first = dwh[0]
        raw_dim = {
            "d": first.get("depth") or first.get("length") or {"unit": "centimeters", "value": 10.0},
            "w": first.get("width") or {"unit": "centimeters", "value": 10.0},
            "h": first.get("height") or {"unit": "centimeters", "value": 10.0},
        }
    elif lwh and len(lwh) > 0:
        first = lwh[0]
        raw_dim = {
            "d": first.get("length") or {"unit": "centimeters", "value": 10.0},
            "w": first.get("width") or {"unit": "centimeters", "value": 10.0},
            "h": first.get("height") or {"unit": "centimeters", "value": 10.0},
        }

    if allowed_props:
        # Si el esquema pide item_length_width_height
        if "item_length_width_height" in allowed_props:
            target_attrs.pop("item_depth_width_height", None)
            if raw_dim:
                target_attrs["item_length_width_height"] = [{
                    "length": raw_dim["d"],
                    "width": raw_dim["w"],
                    "height": raw_dim["h"],
                    "marketplace_id": target_mp_id,
                }]
        # Si pide item_depth_width_height
        elif "item_depth_width_height" in allowed_props:
            target_attrs.pop("item_length_width_height", None)
            if raw_dim:
                target_attrs["item_depth_width_height"] = [{
                    "depth": raw_dim["d"],
                    "width": raw_dim["w"],
                    "height": raw_dim["h"],
                    "marketplace_id": target_mp_id,
                }]
        else:
            target_attrs.pop("item_depth_width_height", None)
            target_attrs.pop("item_length_width_height", None)

        # Si pide item_length
        if "item_length" in allowed_props and "item_length" not in target_attrs:
            val_len = raw_dim["d"] if raw_dim else {"unit": "centimeters", "value": 10.0}
            target_attrs["item_length"] = [{
                "value": val_len.get("value", 10.0),
                "unit": val_len.get("unit", "centimeters"),
                "marketplace_id": target_mp_id,
            }]

        # Si pide item_length_width
        if "item_length_width" in allowed_props and "item_length_width" not in target_attrs:
            val_len = raw_dim["d"] if raw_dim else {"unit": "centimeters", "value": 10.0}
            val_wid = raw_dim["w"] if raw_dim else {"unit": "centimeters", "value": 10.0}
            target_attrs["item_length_width"] = [{
                "length": val_len,
                "width": val_wid,
                "marketplace_id": target_mp_id,
            }]

        # unit_count
        if "unit_count" in allowed_props and "unit_count" not in target_attrs:
            unit_val = "unità" if "it" in lang_tag.lower() else "unité"
            target_attrs["unit_count"] = [{
                "type": {"value": unit_val, "language_tag": lang_tag},
                "value": 1.0,
                "marketplace_id": target_mp_id,
            }]

        # is_fragile
        if "is_fragile" in allowed_props:
            target_attrs["is_fragile"] = [{"value": False, "marketplace_id": target_mp_id}]
        else:
            target_attrs.pop("is_fragile", None)

        # power_plug_type
        if "power_plug_type" in allowed_props:
            target_attrs["power_plug_type"] = [{"value": "no_plug", "marketplace_id": target_mp_id}]
        else:
            target_attrs.pop("power_plug_type", None)

        # recommended_browse_nodes si es requerido por el esquema de destino
        if "recommended_browse_nodes" in allowed_props:
            rbn_es = attrs_es.get("recommended_browse_nodes", [])
            if rbn_es and len(rbn_es) > 0:
                target_attrs["recommended_browse_nodes"] = [{
                    "value": str(rbn_es[0].get("value")),
                    "marketplace_id": target_mp_id,
                }]

        # Filtrar atributos que no existan en el esquema para evitar errores 90000900
        keys_to_del = [k for k in target_attrs.keys() if k not in allowed_props]
        for k in keys_to_del:
            target_attrs.pop(k, None)

    # Atributos comúnmente obligatorios si no vienen definidos
    if "batteries_required" in allowed_props and "batteries_required" not in target_attrs:
        target_attrs["batteries_required"] = [{"value": False, "marketplace_id": target_mp_id}]
    if "supplier_declared_dg_hz_regulation" in allowed_props and "supplier_declared_dg_hz_regulation" not in target_attrs:
        target_attrs["supplier_declared_dg_hz_regulation"] = [{"value": "not_applicable", "marketplace_id": target_mp_id}]

    return target_attrs


def create_listing(token: str, base_url: str, sku: str, product_type: str, attributes: Dict[str, Any], target_code: str) -> Dict[str, Any]:
    """Crea la ficha de producto completa en el marketplace destino."""
    mkt = TARGET_MARKETPLACES[target_code]
    url = f"{base_url}/listings/2021-08-01/items/{SELLER_ID}/{sku}?marketplaceIds={mkt['id']}&issueLocale={mkt['locale']}"
    headers = {"x-amz-access-token": token, "Content-Type": "application/json"}

    body = {
        "productType": product_type or "PRODUCT",
        "requirements": "LISTING",
        "attributes": attributes,
    }

    for attempt in range(1, 4):
        try:
            res = requests.put(url, headers=headers, json=body, timeout=20)
            if res.status_code == 200:
                data = res.json()
                if data.get("status") in ("ACCEPTED", "VALID"):
                    return {"success": True, "data": data}
                else:
                    return {"success": False, "issues": data.get("issues", [])}
            elif res.status_code == 429:
                time.sleep(attempt * 10)
            else:
                return {"success": False, "error": f"HTTP {res.status_code}: {res.text}"}
        except Exception as e:
            time.sleep(2)

    return {"success": False, "error": "Excedido límite de reintentos"}


def main():
    parser = argparse.ArgumentParser(description="Creador y sincronizador de listings en Italia y Francia")
    parser.add_argument("--sku", help="Procesar un solo SKU de prueba")
    parser.add_argument("--limit", type=int, default=0, help="Límite de SKUs a procesar (0 = sin límite)")
    parser.add_argument("--marketplaces", default="IT,FR", help="Mercados destino separados por coma (ej: IT,FR)")
    parser.add_argument("--dry-run", action="store_true", help="Modo simulación")
    args = parser.parse_args()

    target_m_codes = [c.strip().upper() for c in args.marketplaces.split(",") if c.strip().upper() in TARGET_MARKETPLACES]
    if not target_m_codes:
        log("❌ No se especificaron mercados válidos (IT, FR).")
        return

    m_names = ", ".join([f"{TARGET_MARKETPLACES[c]['flag']} {TARGET_MARKETPLACES[c]['name']}" for c in target_m_codes])
    log(f"🌍 Mercados destino: {m_names}")

    token = get_access_token()
    base_url = get_base_url()

    if args.sku:
        candidate_skus = [args.sku.strip()]
    else:
        candidate_skus = load_target_skus()
        if args.limit > 0:
            candidate_skus = candidate_skus[:args.limit]

    log(f"🚀 Iniciando proceso de análisis y creación para {len(candidate_skus):,} SKUs...")

    created_counts = {c: 0 for c in target_m_codes}
    already_counts = {c: 0 for c in target_m_codes}
    skipped_no_es = 0

    req_count = 0
    for idx, sku in enumerate(candidate_skus, 1):
        req_count += 1
        if req_count % 40 == 0:
            token = get_access_token()

        # 1. Obtener datos de España
        es_data = get_spanish_listing(token, base_url, sku)
        if not es_data or not es_data.get("summaries"):
            skipped_no_es += 1
            continue

        product_type = es_data["summaries"][0].get("productType", "PRODUCT")
        attrs_es = es_data.get("attributes", {})
        if not attrs_es:
            skipped_no_es += 1
            continue

        for m_code in target_m_codes:
            m_info = TARGET_MARKETPLACES[m_code]
            # 2. Verificar si ya existe en destino
            exists = check_marketplace_listing(token, base_url, sku, m_info["id"])
            if exists:
                already_counts[m_code] += 1
                continue

            if args.dry_run:
                log(f"   [DRY-RUN] Simulado alta para SKU {sku} en {m_info['flag']} {m_info['name']} (+{m_info['price_offset']}€)")
                created_counts[m_code] += 1
                continue

            # 3. Construir atributos adaptados con validación de esquema
            attrs_target = build_target_attributes(
                token,
                base_url,
                attrs_es,
                product_type,
                m_info["id"],
                m_info["locale"],
                m_info["price_offset"]
            )

            # 4. Crear listing en destino
            c_res = create_listing(token, base_url, sku, product_type, attrs_target, m_code)
            if c_res.get("success"):
                created_counts[m_code] += 1
                log(f"[{idx}/{len(candidate_skus)}] ✅ {m_info['flag']} [{m_code}] Creado con éxito SKU {sku} (PVP con +{m_info['price_offset']}€).")
            else:
                log(f"[{idx}/{len(candidate_skus)}] ⚠️ {m_info['flag']} [{m_code}] No se pudo crear {sku}: {c_res.get('issues') or c_res.get('error')}")

            time.sleep(0.5)

    log("=" * 70)
    log("🏁 PROCESO FINALIZADO:")
    for m_code in target_m_codes:
        log(f"   {TARGET_MARKETPLACES[m_code]['flag']} {TARGET_MARKETPLACES[m_code]['name']}: {created_counts[m_code]} nuevos creados | {already_counts[m_code]} ya existían")
    log(f"   ⚠️ SKUs sin ficha en España: {skipped_no_es}")
    log("=" * 70)


if __name__ == "__main__":
    main()
