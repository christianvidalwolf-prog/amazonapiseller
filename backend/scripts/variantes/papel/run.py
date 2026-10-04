"""Familia de papel de regalo en rollo en ES/DE/FR/IT. Uso: python3 run.py preview|submit [ES,DE,...] [familia,...]"""
import sys, os, json, time, collections, urllib.parse
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, "../../../.."))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
import requests
from auth import get_access_token, get_base_url
from spec import *
from families import FAMILIES

SELLER = "A3RY0L9OY3TPHI"
MODE = sys.argv[1]
ONLY = sys.argv[2].split(",") if len(sys.argv) > 2 else list(MARKETS)
FAMS = sys.argv[3].split(",") if len(sys.argv) > 3 else list(FAMILIES)
LOG = f"{HERE}/write_log.jsonl"

def call(method, sku, mid, body=None, params=None):
    url = f"{get_base_url()}/listings/2021-08-01/items/{SELLER}/{urllib.parse.quote(sku, safe='')}"
    for a in range(7):
        r = requests.request(method, url, params={"marketplaceIds": mid, **(params or {})}, json=body,
                             headers={"x-amz-access-token": get_access_token(), "Content-Type": "application/json"}, timeout=60)
        if r.status_code in (429, 500, 503): time.sleep(2 ** a); continue
        return r.status_code, (r.json() if r.text else {})
    return 0, {}

def log(o): open(LOG, "a").write(json.dumps({"t": time.time(), **o}, ensure_ascii=False) + "\n")
errs = lambda r: [(i["code"], i["message"][:160]) for i in r.get("issues", []) if i["severity"] == "ERROR"]

# Comprobaciones de la especificación: cada combinación medida/diseño, única en cada idioma
for code in MARKETS:
    combos = collections.Counter((CHILDREN[s][0], design_name(s, code)) for s in CHILDREN)
    assert not [c for c, n in combos.items() if n > 1], (code, [c for c, n in combos.items() if n > 1])

KEEP_PARENT = ["bullet_point", "product_description", "country_of_origin", "supplier_declared_dg_hz_regulation", "material",
               "main_product_image_locator", "other_product_image_locator_1", "other_product_image_locator_2",
               "other_product_image_locator_3", "recommended_browse_nodes", "generic_keyword", "manufacturer"]

def parent_body(fam, code, mid, lang):
    st, rep = call("GET", fam["rep"], mid, params={"includedData": "attributes"})
    a = rep.get("attributes", {})
    attrs = {k: [dict(x, marketplace_id=mid) for x in a[k]] for k in KEEP_PARENT if k in a}
    attrs.update({
        "bullet_point": [{"value": b, "language_tag": lang, "marketplace_id": mid} for b in fam["bullets"][code]],
        "product_description": [{"value": fam["desc"][code], "language_tag": lang, "marketplace_id": mid}],
        "country_of_origin": [{"value": "ES", "marketplace_id": mid}],
        "batteries_required": [{"value": False, "marketplace_id": mid}],
        "supplier_declared_dg_hz_regulation": [{"value": "not_applicable", "marketplace_id": mid}],
        "item_name": [{"value": fam["title"][code], "language_tag": lang, "marketplace_id": mid}],
        "brand": [{"value": "ROCKING GIFTS", "language_tag": lang, "marketplace_id": mid}],
        "parentage_level": [{"value": "parent", "marketplace_id": mid}],
        "variation_theme": [{"name": THEME, "marketplace_id": mid}],
        "supplier_declared_has_product_identifier_exemption": [{"value": True, "marketplace_id": mid}],
    })
    return {"productType": PRODUCT_TYPE, "requirements": "LISTING_PRODUCT_ONLY", "attributes": attrs}

def child_body(fam, sku, code, mid, lang):
    size, pack, _ = CHILDREN[sku]
    val = lambda x: [{"value": x, "language_tag": lang, "marketplace_id": mid}]
    patches = [
        {"op": "replace", "path": "/attributes/parentage_level", "value": [{"value": "child", "marketplace_id": mid}]},
        {"op": "replace", "path": "/attributes/child_parent_sku_relationship", "value": [{"child_relationship_type": "variation", "parent_sku": fam["parent_sku"], "marketplace_id": mid}]},
        {"op": "replace", "path": "/attributes/variation_theme", "value": [{"name": THEME, "marketplace_id": mid}]},
        {"op": "replace", "path": "/attributes/color", "value": val(design_name(sku, code))},
        {"op": "replace", "path": "/attributes/size", "value": val(size)},
    ]
    if isinstance(pack, int):
        patches.append({"op": "replace", "path": "/attributes/number_of_items", "value": [{"value": pack, "marketplace_id": mid}]})
    return {"productType": PRODUCT_TYPE, "patches": patches}

live = json.load(open(f"{HERE}/live_2026-10-04.json"))
present = {s: {x["marketplaceId"] for x in live[s]["summaries"]} for s in CHILDREN}
summary = {}
pool = ThreadPoolExecutor(3)
for fname in FAMS:
  fam = FAMILIES[fname]; P = fam["parent_sku"]
  for code in ONLY:
    mid, lang = MARKETS[code]
    kids = [s for s in fam["children"] if mid in present[s]]
    if not kids: print(f"{fname} {code}: sin hijos en este país"); continue
    pb = parent_body(fam, code, mid, lang)
    st, r = call("PUT", P, mid, pb, {"mode": "VALIDATION_PREVIEW"})
    perr = errs(r)
    pre = dict(zip(kids, pool.map(lambda s: call("PATCH", s, mid, child_body(fam, s, code, mid, lang), {"mode": "VALIDATION_PREVIEW"})[1], kids)))
    bad = {s: errs(r2) or r2.get("status") for s, r2 in pre.items() if r2.get("status") != "VALID"}
    print(f"{fname} {code}: padre {'VALID' if r.get('status') == 'VALID' else perr} | hijos {len(kids)} | con error {len(bad)}")
    for s, e in bad.items(): print(f"   {s}: {e}")
    summary[f"{fname}:{code}"] = {"parent": r.get("status"), "parent_errors": perr, "kids": len(kids), "bad": bad}
    if MODE == "submit":
        if r.get("status") != "VALID": print(f"   padre no válido, no se envía"); continue
        if len(kids) - len(bad) < 2: print(f"   menos de 2 hijos válidos, no se crea la familia"); continue
        st, r = call("PUT", P, mid, pb); log({"op": "PUT parent", "fam": fname, "mk": code, "sku": P, "status": st, "resp": r})
        print(f"   padre: {r.get('status')}")
        time.sleep(2)
        def send(s):
            st2, r2 = call("PATCH", s, mid, child_body(fam, s, code, mid, lang))
            log({"op": "PATCH child", "fam": fname, "mk": code, "sku": s, "spec": CHILDREN[s], "status": st2, "resp": r2})
            return s, r2
        ok = 0
        for s, r2 in pool.map(send, [s for s in kids if s not in bad]):
            ok += r2.get("status") == "ACCEPTED"
            if r2.get("status") != "ACCEPTED": print(f"   {s}: {r2.get('status')} {errs(r2)}")
        print(f"   hijos aceptados: {ok}/{len(kids) - len(bad)}")
json.dump(summary, open(f"{HERE}/last_{MODE}.json", "w"), ensure_ascii=False, indent=1)
