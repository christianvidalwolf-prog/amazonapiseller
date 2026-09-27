import sys, os, json, time, threading, urllib.parse
sys.path.insert(0,"/Users/christianvidalwolf/AMAZON AWS SP-API"); os.chdir("/Users/christianvidalwolf/AMAZON AWS SP-API")
import requests
from concurrent.futures import ThreadPoolExecutor
from auth import get_access_token, get_base_url
S=sys.argv[1]; SELLER=os.getenv("SP_API_SELLER_ID","A3RY0L9OY3TPHI"); MP="A1RKKUPIHCS9HS"
items=json.load(open(f"{S}/items.json")); cache_f=f"{S}/listings_cache.jsonl"
done=set()
if os.path.exists(cache_f):
    for l in open(cache_f): done.add(json.loads(l)['sku'])
todo=[d['sku'] for d in items if d['sku'] not in done]; print("todo",len(todo),flush=True)
KEEP=['brand','color','size','item_type_keyword','parentage_level','child_parent_sku_relationship','variation_theme','material','number_of_items','item_package_quantity','style','pattern','scent','item_shape','finish_type','theme','item_width_height','item_length_width','item_depth_width_height','item_dimensions','unit_count']
lock=threading.Lock(); last=[0.0]; out=open(cache_f,"a")
def tick():
    with lock:
        w=last[0]+0.2-time.time()
        if w>0: time.sleep(w)
        last[0]=time.time()
def get(sku):
    url=f"{get_base_url()}/listings/2021-08-01/items/{SELLER}/{urllib.parse.quote(sku,safe='')}"
    for a in range(6):
        tick()
        r=requests.get(url,params={"marketplaceIds":MP,"includedData":"summaries,attributes,relationships,issues"},headers={"x-amz-access-token":get_access_token()},timeout=30)
        if r.status_code==429 or r.status_code>=500: time.sleep(2**a); continue
        break
    rec={'sku':sku,'http':r.status_code}
    if r.status_code==200:
        j=r.json(); s=(j.get('summaries') or [{}])[0]; at=j.get('attributes',{})
        rec.update(productType=s.get('productType'),asin=s.get('asin'),status=s.get('status'),itemName=s.get('itemName'),
          image=(s.get('mainImage') or {}).get('link'),
          attrs={k:at[k] for k in KEEP if k in at},
          rel=j.get('relationships'),issues=[i.get('code')+':'+i.get('severity','') for i in j.get('issues',[])][:5])
    with lock: out.write(json.dumps(rec,ensure_ascii=False)+"\n"); out.flush()
n=0
with ThreadPoolExecutor(6) as ex:
    for _ in ex.map(get,todo):
        n+=1
        if n%250==0: print(n,flush=True)
print("done")
