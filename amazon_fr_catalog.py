import os
import csv
import json
import re
import requests
from auth import get_access_token, get_base_url

MARKETPLACE_FR = "A13V1IB3VIYZZH"
TRANSLATIONS_CACHE_FILE = "translations_cache.json"


def _clean_text(value) -> str:
    """Quita HTML y colapsa espacios (Cdiscount no admite HTML en title/description)."""
    text = str(value or "")
    text = re.sub(r"<[^>]+>", " ", text)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&quot;", '"')
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _attr_values(attributes: dict, name: str) -> list:
    """Valores de un atributo de Amazon FR ([{'value': ...}] o [{'name': ...}])."""
    raw = (attributes or {}).get(name) or []
    values = []
    for item in raw:
        if isinstance(item, dict):
            value = item.get("value") or item.get("name")
        else:
            value = item
        cleaned = _clean_text(value)
        if cleaned:
            values.append(cleaned)
    return values


def _classification_path(classifications) -> str:
    """Ruta legible de la clasificación FR: 'Pierres thérapeutiques > Bien-être > Santé'."""
    try:
        node = classifications[0]["classifications"][0]
    except (KeyError, IndexError, TypeError):
        return ""
    names = []
    while isinstance(node, dict) and node:
        if node.get("displayName"):
            names.append(node["displayName"])
        node = node.get("parent")
    return " > ".join(reversed(names))


class AmazonFRCatalog:
    def __init__(self, catalog_csv="catalogo_completo.csv"):
        self.catalog_csv = catalog_csv
        self.translations = {}
        if os.path.exists(TRANSLATIONS_CACHE_FILE):
            try:
                with open(TRANSLATIONS_CACHE_FILE, "r", encoding="utf-8") as f:
                    self.translations = json.load(f)
            except Exception:
                pass

    def get_missing_products_from_csv(self, missing_csv="productos_faltan_en_cdiscount.csv") -> list:
        products = []
        if not os.path.exists(missing_csv):
            return products

        with open(missing_csv, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f, delimiter=";")
            for row in reader:
                ean = row.get("ean", "").strip()
                # Filtrar solo EANs numéricos válidos
                if ean.isdigit() and len(ean) in [8, 12, 13, 14]:
                    products.append(row)
        return products

    def fetch_product_details(self, asin: str) -> dict:
        """
        Ficha del ASIN en Amazon Francia.

        Además de título/marca/imagen devuelve los elementos que Cdiscount usa
        para categorizar y validar la ficha: clasificación FR (browseClassification
        y su ruta de padres), tipo de producto y los atributos ricos
        (product_description, bullet_point, color, size, variation_theme).
        Cdiscount rechaza fichas con CategorizationError cuando el título y la
        descripción "no son lo bastante explícitos": estos extras son justo los
        "más elementos" que pide.
        """
        if not asin:
            return None

        try:
            token = get_access_token()
            base_url = get_base_url()
            url = f"{base_url}/catalog/2022-04-01/items/{asin}"
            params = {
                "marketplaceIds": MARKETPLACE_FR,
                "includedData": "summaries,images,productTypes,classifications,attributes"
            }
            headers = {
                "x-amz-access-token": token,
                "Content-Type": "application/json"
            }
            res = requests.get(url, headers=headers, params=params, timeout=12)
            if res.status_code == 200:
                data = res.json()
                summaries = data.get("summaries", [{}])[0]
                images_data = data.get("images", [{}])[0].get("images", [])
                main_image = images_data[0].get("link") if images_data else None
                attributes = data.get("attributes") or {}
                product_types = data.get("productTypes") or [{}]

                classification = summaries.get("browseClassification") or {}

                return {
                    "title": summaries.get("itemName"),
                    "brand": summaries.get("brand", "Generic"),
                    "image": main_image,
                    "classification": classification.get("displayName"),
                    "classification_path": _classification_path(data.get("classifications")),
                    "product_type": product_types[0].get("productType"),
                    "description": (_attr_values(attributes, "product_description") or [""])[0],
                    "bullets": _attr_values(attributes, "bullet_point"),
                    "color": (_attr_values(attributes, "color") or [""])[0],
                    "size": (_attr_values(attributes, "size") or [""])[0],
                    "variation_theme": (_attr_values(attributes, "variation_theme") or [""])[0],
                }
        except Exception as e:
            print(f"  ⚠️ Error consultando ASIN {asin}: {e}")

        return None
