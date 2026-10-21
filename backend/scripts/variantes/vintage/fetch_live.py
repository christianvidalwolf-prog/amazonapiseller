"""Descarga summaries/relationships/attributes de los candidatos en ES/DE/FR/IT -> live_<fecha>.json"""
import sys, os, json, time, urllib.parse, datetime
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../../.."))
sys.path.insert(0, ROOT); os.chdir(ROOT)
import requests
from auth import get_access_token, get_base_url
SELLER = "A3RY0L9OY3TPHI"
MIDS = "A1RKKUPIHCS9HS,A1PA6795UKMFR9,A13V1IB3VIYZZH,APJ6JRA9NG5V4"

def get(sku):
    url = f"{get_base_url()}/listings/2021-08-01/items/{SELLER}/{urllib.parse.quote(sku, safe='')}"
    for a in range(7):
        r = requests.get(url, params={"marketplaceIds": MIDS, "includedData": "summaries,relationships,attributes,fulfillmentAvailability"},
                         headers={"x-amz-access-token": get_access_token()}, timeout=60)
        if r.status_code in (429, 500, 503): time.sleep(2 ** a); continue
        return r.json() if r.status_code == 200 else {"sku": sku, "error": r.status_code, "summaries": []}
    return {"sku": sku, "error": "throttled", "summaries": []}

skus = list(json.load(open(f"{HERE}/candidates.json")))
with ThreadPoolExecutor(4) as ex: res = dict(zip(skus, ex.map(get, skus)))
out = f"{HERE}/live_{datetime.date.today()}.json"
json.dump(res, open(out, "w"), ensure_ascii=False)
print(out, len(res), "errores:", sum(1 for v in res.values() if v.get("error")))
