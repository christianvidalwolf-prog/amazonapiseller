#!/usr/bin/env python3
"""
Traductor y Actualizador Masivo de Listings para Amazon Italia (IT) y Francia (FR).

Recorre los productos dados de alta en España y traduce automáticamente los campos de texto
(título/item_name, viñetas/bullet_point y descripción/product_description) al idioma nativo
de cada país:
  - Italia (IT): Italiano (it_IT)
  - Francia (FR): Francés (fr_FR)

Aplica las modificaciones mediante la API de Listings Items (PATCH) sin alterar precios ni inventarios.
"""

import os
import sys
import time
import json
import argparse
import urllib.request
import urllib.parse
from datetime import datetime
from typing import Optional, Dict, Any, List

import requests
from auth import get_access_token, get_base_url
from create_listings_eu import load_target_skus, get_spanish_listing, TARGET_MARKETPLACES, SELLER_ID

TRANSLATION_CACHE_FILE = "translations_cache.json"
TRANSLATION_CACHE = {}

if os.path.exists(TRANSLATION_CACHE_FILE):
    try:
        with open(TRANSLATION_CACHE_FILE, "r", encoding="utf-8") as f:
            TRANSLATION_CACHE = json.load(f)
    except Exception:
        TRANSLATION_CACHE = {}


def save_cache():
    try:
        with open(TRANSLATION_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(TRANSLATION_CACHE, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def log(msg: str):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {msg}", flush=True)


def translate_text(text: str, target_lang: str) -> Optional[str]:
    """Traduce texto de español al idioma destino con caché persistente y fallback multi-proveedor."""
    if not text or not str(text).strip():
        return text
    clean_text = str(text).strip()
    cache_key = f"{target_lang}:{clean_text}"
    if cache_key in TRANSLATION_CACHE:
        return TRANSLATION_CACHE[cache_key]

    # 1. Intento Google GTX
    try:
        url = (
            f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=es&tl={target_lang}&dt=t&q="
            + urllib.parse.quote(clean_text)
        )
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            translated = "".join(part[0] for part in data[0] if part and part[0])
            if translated and translated.strip():
                TRANSLATION_CACHE[cache_key] = translated
                return translated
    except Exception:
        pass

    # 2. Intento MyMemory API (respaldo de alta fiabilidad)
    try:
        url_mm = f"https://api.mymemory.translated.net/get?q={urllib.parse.quote(clean_text[:450])}&langpair=es|{target_lang}"
        req_mm = urllib.request.Request(
            url_mm,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        with urllib.request.urlopen(req_mm, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            res_txt = data.get("responseData", {}).get("translatedText")
            if res_txt and res_txt.strip() and not res_txt.startswith("MYMEMORY WARNING"):
                TRANSLATION_CACHE[cache_key] = res_txt
                return res_txt
    except Exception:
        pass

    # Si no se pudo traducir por rate limit, devolvemos None para no sobreescribir con texto en español
    return None


def patch_listing_texts(
    token: str,
    base_url: str,
    sku: str,
    product_type: str,
    m_info: Dict[str, Any],
    title: str,
    bullets: List[str],
    desc: Optional[str],
) -> Dict[str, Any]:
    """Envía los parches traducidos mediante Listings Items API PATCH."""
    m_id = m_info["id"]
    locale = m_info["locale"]

    patches = [
        {
            "op": "replace",
            "path": "/attributes/item_name",
            "value": [
                {
                    "value": title,
                    "language_tag": locale,
                    "marketplace_id": m_id,
                }
            ],
        }
    ]

    if bullets:
        patches.append(
            {
                "op": "replace",
                "path": "/attributes/bullet_point",
                "value": [
                    {
                        "value": b,
                        "language_tag": locale,
                        "marketplace_id": m_id,
                    }
                    for b in bullets
                ],
            }
        )

    if desc and desc.strip():
        patches.append(
            {
                "op": "replace",
                "path": "/attributes/product_description",
                "value": [
                    {
                        "value": desc,
                        "language_tag": locale,
                        "marketplace_id": m_id,
                    }
                ],
            }
        )

    url = f"{base_url}/listings/2021-08-01/items/{SELLER_ID}/{sku}?marketplaceIds={m_id}&issueLocale={locale}"
    headers = {"x-amz-access-token": token, "Content-Type": "application/json"}
    body = {
        "productType": product_type or "PRODUCT",
        "patches": patches,
    }

    for attempt in range(1, 4):
        try:
            res = requests.patch(url, headers=headers, json=body, timeout=15)
            if res.status_code == 200:
                data = res.json()
                if data.get("status") in ("ACCEPTED", "VALID"):
                    return {"success": True, "data": data}
                else:
                    return {"success": False, "issues": data.get("issues", [])}
            elif res.status_code == 429:
                time.sleep(attempt * 6)
            else:
                return {"success": False, "error": f"HTTP {res.status_code}: {res.text}"}
        except Exception as e:
            time.sleep(2)

    return {"success": False, "error": "Reintentos agotados"}


def main():
    parser = argparse.ArgumentParser(description="Traduce y actualiza títulos, viñetas y descripciones en IT y FR")
    parser.add_argument("--sku", help="Procesar un solo SKU de prueba")
    parser.add_argument("--limit", type=int, default=0, help="Límite de SKUs a procesar (0 = sin límite)")
    parser.add_argument("--marketplaces", default="IT,FR", help="Mercados separados por coma (IT,FR)")
    args = parser.parse_args()

    target_m_codes = [c.strip().upper() for c in args.marketplaces.split(",") if c.strip().upper() in TARGET_MARKETPLACES]
    if not target_m_codes:
        log("❌ Especifica mercados válidos (IT, FR).")
        return

    token = get_access_token()
    base_url = get_base_url()

    if args.sku:
        candidate_skus = [args.sku.strip()]
    else:
        candidate_skus = load_target_skus()
        if args.limit > 0:
            candidate_skus = candidate_skus[:args.limit]

    log(f"🌐 Iniciando traducción y actualización para {len(candidate_skus):,} SKUs en {', '.join(target_m_codes)}...")

    updated_counts = {c: 0 for c in target_m_codes}
    skipped_counts = 0

    req_count = 0
    for idx, sku in enumerate(candidate_skus, 1):
        req_count += 1
        if req_count % 30 == 0:
            token = get_access_token()
            save_cache()

        es_data = get_spanish_listing(token, base_url, sku)
        if not es_data or not es_data.get("summaries"):
            skipped_counts += 1
            continue

        product_type = es_data["summaries"][0].get("productType", "PRODUCT")
        attrs_es = es_data.get("attributes", {})
        if not attrs_es or "item_name" not in attrs_es:
            skipped_counts += 1
            continue

        raw_title = attrs_es["item_name"][0]["value"]
        raw_bullets = [b["value"] for b in attrs_es.get("bullet_point", [])]
        raw_desc = attrs_es["product_description"][0]["value"] if attrs_es.get("product_description") else None

        for m_code in target_m_codes:
            m_info = TARGET_MARKETPLACES[m_code]
            target_lang = "it" if m_code == "IT" else "fr"

            trans_title = translate_text(raw_title, target_lang)
            if not trans_title:
                continue

            trans_bullets = [translate_text(b, target_lang) or b for b in raw_bullets]
            trans_desc = translate_text(raw_desc, target_lang) if raw_desc else None

            res = patch_listing_texts(
                token,
                base_url,
                sku,
                product_type,
                m_info,
                trans_title,
                trans_bullets,
                trans_desc,
            )

            if res.get("success"):
                updated_counts[m_code] += 1
                if idx % 10 == 0 or idx <= 5:
                    log(f"[{idx}/{len(candidate_skus)}] ✅ {m_info['flag']} [{m_code}] {sku}: '{trans_title[:55]}...'")
            else:
                pass

            time.sleep(0.3)

    save_cache()
    log("=" * 70)
    log("🏁 PROCESO DE TRADUCCIÓN FINALIZADO:")
    for m_code in target_m_codes:
        log(f"   {TARGET_MARKETPLACES[m_code]['flag']} {TARGET_MARKETPLACES[m_code]['name']}: {updated_counts[m_code]} listings traducidos y actualizados")
    log("=" * 70)


if __name__ == "__main__":
    main()
