"""Unifica los source.json de Signes/Dcasa en products.json (un registro por SKU)."""
from pathlib import Path
import json

OUT = Path(__file__).resolve().parent.parent / 'data'
# Salida del proyecto ListingCreator (lotes Amazon ya creados)
SRC = Path('/Users/christianvidalwolf/Alta Productos Amazon/output')
ES = 'A1RKKUPIHCS9HS'
# Orden de prioridad: los lotes propios primero, france_all solo rellena huecos.
SOURCES = ['dcasa_lotes_1_10', 'dcasa_de_11', 'dcasa_12_de', 'alemania_bulk_2_8', 'france_all']
MANUFACTURERS = {'images.dcasacollection.com': (5, 'Dcasa'), 'signesconexion.com': (8, 'Signes Grimalt')}


def es(d, field, n=1, suffix='value'):
    return (d.get(f'{field}[marketplace_id={ES}][language_tag=es_ES]#{n}.{suffix}') or '').strip()


def num(v):
    try:
        return float(str(v).replace(',', '.'))
    except (TypeError, ValueError):
        return None


def build():
    products, issues = {}, []
    for src in SOURCES:
        for r in json.loads((SRC / src / 'source.json').read_text()):
            d = r['data']
            sku = (d.get('contribution_sku#1.value') or '').strip()
            if not sku or sku in products:
                continue
            img = d.get(f'main_product_image_locator[marketplace_id={ES}]#1.media_location') or ''
            host = img.split('/')[2] if '//' in img else ''
            id_man, man = MANUFACTURERS.get(host, (0, ''))
            weight = num(d.get(f'item_weight[marketplace_id={ES}]#1.value'))
            unit = (d.get(f'item_weight[marketplace_id={ES}]#1.unit') or '').lower()
            p = {
                'reference': sku,
                'ean13': (d.get('amzn1.volt.ca.product_id_value') or '').strip(),
                'name': es(d, 'item_name'),
                'subtitle': es(d, 'title_differentiation'),
                'description': es(d, 'product_description'),
                'bullets': [b for b in (es(d, 'bullet_point', i) for i in range(1, 6)) if b],
                'material': es(d, 'material'),
                'color': es(d, 'color'),
                'size': es(d, 'size'),
                'image': img,
                'id_manufacturer': id_man,
                'manufacturer': man,
                'price_es': num(d.get(f'purchasable_offer[marketplace_id={ES}][audience=ALL]#1.our_price#1.schedule#1.value_with_tax')),
                'list_price_es': num(d.get(f'list_price[marketplace_id={ES}]#1.value_with_tax')),
                'quantity': int(num(d.get('fulfillment_availability#1.quantity')) or 0),
                'weight_kg': round(weight / 1000, 3) if weight and unit.startswith('gram') else weight,
                'browse_node': d.get(f'recommended_browse_nodes[marketplace_id={ES}]#1.value') or '',
                'amazon_status': d.get('::submission_status') or '',
                'source': src,
                'source_file': r.get('file', ''),
            }
            for field in ('name', 'ean13', 'image', 'price_es'):
                if not p[field]:
                    issues.append({'reference': sku, 'issue': f'sin {field}', 'source': src})
            if not id_man:
                issues.append({'reference': sku, 'issue': f'fabricante desconocido ({host})', 'source': src})
            products[sku] = p

    eans = {}
    for p in products.values():
        if p['ean13']:
            eans.setdefault(p['ean13'], []).append(p['reference'])
    for ean, refs in eans.items():
        if len(refs) > 1:
            issues.append({'reference': ','.join(refs), 'issue': f'EAN duplicado {ean}', 'source': ''})

    (OUT / 'products.json').write_text(json.dumps(list(products.values()), ensure_ascii=False, indent=1))
    (OUT / 'consolidate_issues.json').write_text(json.dumps(issues, ensure_ascii=False, indent=1))
    print(f'{len(products)} productos, {len(issues)} incidencias')


if __name__ == '__main__':
    build()
