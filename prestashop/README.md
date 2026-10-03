# PrestaShop — www.vidalregals.com

Conexión con la tienda web (PrestaShop 1.7, Webservice API) y pipeline de alta masiva de productos.

## Conexión

- Credenciales en el `.env` de la raíz del repo (gitignored): `PS_URL`, `PS_API_KEY`
  (key del Webservice: *Parámetros avanzados › Webservice*).
- `mcp_server.py` — servidor MCP (`uv run`, dependencias inline). Registrado en `.mcp.json`
  como `prestashop`; lee las credenciales del `.env`, así que `.mcp.json` no contiene secretos.
  Herramientas: `shop_info`, `list_categories`, `list_manufacturers`, `list_tax_rules_groups`,
  `find_product`, `get_product`, `create_product`, `update_product`, `set_stock`,
  `upload_images`, `import_from_scrapin`.
- Copia adaptada de `~/A+/prestashop-mcp/server.py` (el workspace A+ sigue usando el suyo).

Datos útiles de la tienda:

| Qué | id |
|---|---|
| IVA ES 21 % (`id_tax_rules_group`) | 1 |
| Fabricante Dcasa / Signes Grimalt / Rocking Gifts | 5 / 8 / 16 |
| Árbol de categorías bueno | hijas de «Catálogo» (82) |
| Idiomas activos | es=1, en=5, fr=6, de=7, it=8 |

El árbol de categorías tiene cientos de duplicados basura («Costureros», «Revisteros», huérfanas,
acentos rotos). **No borrarlos** (decisión del usuario): asignar siempre hojas bajo «Catálogo».

## Pipeline de alta masiva (`pipeline/`)

Datos en `data/` (gitignored). Todo se ejecuta desde `pipeline/`:

```sh
python3 consolidate.py       # source.json de los lotes Amazon -> data/products.json (1 registro por SKU)
python3 categorize.py        # asigna categoría por reglas de palabras clave del título
uv run --quiet load_prestashop.py --check          # compara con la tienda (solo lectura)
uv run --quiet load_prestashop.py --limit 20       # piloto
uv run --quiet load_prestashop.py --workers 3      # resto (reanudable vía data/progress.jsonl)
uv run --quiet load_prestashop.py --retry-images   # reintenta data/image_errors.json
uv run --quiet load_prestashop.py --activate       # activa lo creado (data/activation.jsonl)
```

Reglas de la carga:
- Productos creados **desactivados**; textos solo en español, copiados a los 5 idiomas.
- Precio = precio actual Amazon ES de `~/Stock/STOCK AMZ.csv` (fallback: precio del alta), con IVA.
- Stock inicial = `~/Stock/STOCK AMZ.csv`.
- Fabricante por host de imagen (`signesconexion.com` → Signes Grimalt, `images.dcasacollection.com` → Dcasa).
  Ojo: 44 SKUs con sufijo `SGI` son de Dcasa.
- Excluye posibles duplicados: mismo código de proveedor ya en la tienda con sufijo `SG`/`SGRG` (Signes)
  o `DC`/`CLM` (Dcasa). Lista en `data/possible_duplicates.json`.
- Imágenes: Dcasa sirve algunas como `.JPG`; límite de subida 3000 KB (se reducen con Pillow);
  `signesconexion.com` corta con muchas peticiones seguidas → `--retry-images`.
- El listado completo de productos de la tienda hay que paginarlo (sin paginar da timeout).

## Carga del 27/09/2026 (Signes Grimalt + Dcasa)

- 4.719 SKUs de origen → 4.318 creados (2.201 Signes, 2.117 Dcasa), 401 posibles duplicados no creados.
- ids PrestaShop 61820 en adelante; mapa SKU → id en `data/progress.jsonl`.
- Stock diario: los 4.318 SKUs están en `~/Stock/prestashop_new_skus.csv`, que
  `~/Stock/update_web_stock.py` añade a `Stock Web.csv` en cada ejecución con el proveedor correcto.

## Altas desde Amazon ES (cualquier proveedor)

Para SKUs activos en Amazon ES que no están en la tienda. Datos desde la Listings API (título,
descripción, viñetas, EAN, precio, galería completa) en vez de los lotes de ListingCreator:

```sh
python3 from_listings.py SKUS.txt                                   # -> data/products_amazon_es.json
PS_PRODUCTS=products_amazon_es.json python3 categorize.py
PS_PRODUCTS=products_amazon_es.json uv run --quiet --python 3.12 load_prestashop.py --check
PS_PRODUCTS=products_amazon_es.json uv run --quiet --python 3.12 load_prestashop.py --workers 3
```

- Fabricante por sufijo del SKU: SG/SGR/SGRG/SGRI/RGSG → Signes (8); DC/DCI/CLM/SGI/RGCLM → Dcasa (5);
  VC/VCI/VCT/… → Mineral Import (12); MD/MDRG → Madelcar (6). Minerales sin categoría → «Minerales» (51).
- Se descartan listings sin imagen (suprimidos) y SKUs repetidos con sufijo FBA/FBS/RG (queda el FBM).
- Stock con tope `MAX_QTY = 99` (dropshipping VC anuncia miles en Amazon).
- `data/no_activar.txt`: referencias creadas que `--activate` salta (duplicados).

Carga del 27/09/2026: 4.274 creados (ids 66138–70412, desactivados): Dcasa 2.340, Mineral Import 977,
Signes 726, Madelcar 208, sin fabricante 23.
