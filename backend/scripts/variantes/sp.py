import sys,os,json,urllib.parse,time
sys.path.insert(0,"/Users/christianvidalwolf/AMAZON AWS SP-API"); os.chdir("/Users/christianvidalwolf/AMAZON AWS SP-API")
import requests
from auth import get_access_token,get_base_url
SELLER=os.getenv("SP_API_SELLER_ID","A3RY0L9OY3TPHI"); MP="A1RKKUPIHCS9HS"
def set_marketplace(mp_id):
    global MP
    MP = mp_id
def call(method,sku,body=None,params=None):
    url=f"{get_base_url()}/listings/2021-08-01/items/{SELLER}/{urllib.parse.quote(sku,safe='')}"
    p={"marketplaceIds":MP,**(params or {})}
    for a in range(6):
        r=requests.request(method,url,params=p,json=body,headers={"x-amz-access-token":get_access_token(),"Content-Type":"application/json"},timeout=60)
        if r.status_code in (429,500,503): time.sleep(2**a); continue
        if r.text:
            try:
                return r.status_code,r.json()
            except Exception:
                return r.status_code,{}
        return r.status_code,{}
def get_full(sku): return call("GET",sku,params={"includedData":"summaries,attributes,issues,relationships"})[1]
