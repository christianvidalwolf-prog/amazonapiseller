"""Construye data/products_amazon_es.json desde la Listings API de Amazon ES (un registro por SKU).

Para SKUs que están en Amazon ES pero no en la tienda, sea cual sea el proveedor. Mismo formato
que products.json de consolidate.py, así que categorize.py y load_prestashop.py lo aceptan con
PS_PRODUCTS=products_amazon_es.json.

Uso:
  python3 from_listings.py SKUS.txt      # un SKU por línea; reanudable (cachea cada respuesta)
"""
import json
import re
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from auth import get_access_token, get_base_url  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / 'data'
CACHE = OUT / 'listings_es_cache.jsonl'
SELLER = 'A3RY0L9OY3TPHI'
ES = 'A1RKKUPIHCS9HS'

# Sufijo del SKU -> (id_manufacturer, nombre). FBA final = mismo producto.
SUFFIX_MANUFACTURER = {
    **dict.fromkeys(('SG', 'SGR', 'SGRG', 'SGRI', 'RGSG'), (8, 'Signes Grimalt')),
    **dict.fromkeys(('DC', 'DCI', 'CLM', 'SGI', 'RGCLM'), (5, 'Dcasa')),
    **dict.fromkeys(('VC', 'VCI', 'VCT', 'VCO', 'VCFBS', 'VCRG', 'GVC', 'RGVC'), (12, 'Mineral Import')),
    **dict.fromkeys(('MD', 'MDRG'), (6, 'Madelcar')),
}

_lock = threading.Lock()
_last = [0.0]


def manufacturer(sku: str) -> tuple[int, str]:
    m = re.match(r'^[0-9]+([A-Z]*?)[0-9]*(FBA)?$', sku.upper())
    return SUFFIX_MANUFACTURER.get(m.group(1), (0, '')) if m else (0, '')


def fetch(sku: str) -> dict:
    url = f'{get_base_url()}/listings/2021-08-01/items/{SELLER}/{urllib.parse.quote(sku, safe="")}'
    params = {'marketplaceIds': ES, 'includedData': 'summaries,attributes,offers,fulfillmentAvailability'}
    for attempt in range(7):
        with _lock:  # getListingsItem: 5 req/s
            wait = _last[0] + 0.22 - time.time()
            if wait > 0:
                time.sleep(wait)
            _last[0] = time.time()
        try:
            r = requests.get(url, params=params, headers={'x-amz-access-token': get_access_token()}, timeout=60)
        except requests.RequestException:
            time.sleep(2 ** attempt)
            continue
        if r.status_code in (429, 500, 502, 503):
            time.sleep(2 ** attempt)
            continue
        return {'sku': sku, 'http': r.status_code, 'body': r.json() if r.text else {}}
    return {'sku': sku, 'http': 0, 'body': {}}


def first(attrs: dict, field: str, key: str = 'value') -> str:
    for v in attrs.get(field, []):
        if v.get('marketplace_id') in (None, ES) and v.get(key) not in (None, ''):
            return str(v[key]).strip()
    return ''


def num(v):
    try:
        return float(str(v).replace(',', '.'))
    except (TypeError, ValueError):
        return None


def build(rec: dict) -> dict:
    body = rec['body']
    a = body.get('attributes', {})
    summ = next((s for s in body.get('summaries', []) if s.get('marketplaceId') == ES), {})
    images = [first(a, 'main_product_image_locator', 'media_location')]
    images += [first(a, f'other_product_image_locator_{i}', 'media_location') for i in range(1, 9)]
    images = [i for i in images if i] or ([summ['mainImage']['link']] if summ.get('mainImage') else [])
    ean = next((v['value'] for v in a.get('externally_assigned_product_identifier', [])
                if v.get('type', '').lower() == 'ean'), '')
    price = None
    for o in a.get('purchasable_offer', []):
        if o.get('marketplace_id') == ES:
            sched = (o.get('our_price') or [{}])[0].get('schedule') or [{}]
            price = num(sched[0].get('value_with_tax'))
    if price is None:
        price = next((num(o['price']['amount']) for o in body.get('offers', [])
                      if o.get('marketplaceId') == ES and o.get('offerType') == 'B2C'), None)
    qty = next((int(f.get('quantity') or 0) for f in body.get('fulfillmentAvailability', [])
                if f.get('fulfillmentChannelCode') == 'DEFAULT'), 0)
    w = next((v for v in a.get('item_weight', []) if v.get('value')), {})
    weight = num(w.get('value'))
    if weight and str(w.get('unit', '')).lower().startswith('gram'):
        weight = round(weight / 1000, 3)
    id_man, man = manufacturer(rec['sku'])
    return {
        'reference': rec['sku'],
        'ean13': ean,
        'name': first(a, 'item_name') or summ.get('itemName', ''),
        'subtitle': '',
        'description': '' if first(a, 'product_description') == '0' else first(a, 'product_description'),
        'bullets': [b for b in (v.get('value', '').strip() for v in a.get('bullet_point', []))
                    if len(b.strip('☆ .')) > 2][:5],
        'material': first(a, 'material'),
        'color': first(a, 'color'),
        'size': first(a, 'size'),
        'image': images[0] if images else '',
        'images': images,
        'id_manufacturer': id_man,
        'manufacturer': man,
        'price_es': price,
        'list_price_es': num(first(a, 'list_price', 'value_with_tax')),
        'quantity': qty,
        'weight_kg': weight,
        'browse_node': first(a, 'recommended_browse_nodes'),
        'amazon_status': ','.join(summ.get('status', [])),
        'asin': summ.get('asin', ''),
        'source': 'listings_api_es',
        'source_file': '',
    }


def main() -> None:
    skus = [s.strip() for s in Path(sys.argv[1]).read_text().splitlines() if s.strip()]
    done = {}
    if CACHE.exists():
        for line in CACHE.read_text().splitlines():
            r = json.loads(line)
            if r['http'] == 200:
                done[r['sku']] = r
    todo = [s for s in skus if s not in done]
    print(f'{len(skus)} SKUs, {len(done)} en caché, {len(todo)} por descargar', flush=True)
    with ThreadPoolExecutor(max_workers=5) as pool, CACHE.open('a') as f:
        for n, rec in enumerate(pool.map(fetch, todo), 1):
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
            if rec['http'] == 200:
                done[rec['sku']] = rec
            if n % 250 == 0 or rec['http'] != 200:
                print(f'[{n}/{len(todo)}] {rec["sku"]} http={rec["http"]}', flush=True)

    products, issues = [], []
    for sku in skus:
        if sku not in done:
            issues.append({'reference': sku, 'issue': 'no descargado'})
            continue
        p = build(done[sku])
        for field in ('name', 'image', 'price_es'):
            if not p[field]:
                issues.append({'reference': sku, 'issue': f'sin {field}'})
        if not p['id_manufacturer']:
            issues.append({'reference': sku, 'issue': 'fabricante desconocido'})
        if p['image']:  # sin imagen = listing suprimido en Amazon: no se da de alta
            products.append(p)
    # Mismo producto con SKU FBA / RG / FBS: se queda uno (el FBM si existe).
    base = lambda p: (re.sub(r'(FBA|FBS|RG)', '', p['reference'].upper()), p['id_manufacturer'])
    groups: dict = {}
    for p in products:
        groups.setdefault(base(p), []).append(p)
    products = []
    for g in groups.values():
        g.sort(key=lambda p: p['reference'].upper().endswith(('FBA', 'FBS')))
        products.append(g[0])
        issues += [{'reference': p['reference'], 'issue': f'mismo producto que {g[0]["reference"]}'} for p in g[1:]]
    (OUT / 'products_amazon_es.json').write_text(json.dumps(products, ensure_ascii=False, indent=1))
    (OUT / 'from_listings_issues.json').write_text(json.dumps(issues, ensure_ascii=False, indent=1))
    print(f'{len(products)} productos, {len(issues)} incidencias')


if __name__ == '__main__':
    main()
