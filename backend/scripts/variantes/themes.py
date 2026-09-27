import sys,os,json,time
sys.path.insert(0,"/Users/christianvidalwolf/AMAZON AWS SP-API"); os.chdir("/Users/christianvidalwolf/AMAZON AWS SP-API")
import requests
from auth import get_access_token,get_base_url
S=sys.argv[1]; pts=sys.argv[2].split(',')
f=f"{S}/themes.json"; res=json.load(open(f)) if os.path.exists(f) else {}
for pt in pts:
    if pt in res: continue
    r=requests.get(f"{get_base_url()}/definitions/2020-09-01/productTypes/{pt}",params={"marketplaceIds":"A1RKKUPIHCS9HS","requirements":"LISTING","locale":"es_ES"},headers={"x-amz-access-token":get_access_token()})
    if r.status_code!=200: print(pt,r.status_code,r.text[:200]); time.sleep(1); continue
    j=r.json(); sch=requests.get(j['schema']['link']['resource']).json()
    vt=sch['properties'].get('variation_theme',{})
    enum=vt.get('items',{}).get('properties',{}).get('name',{}).get('enum',[])
    res[pt]={'themes':enum,'pvt':j.get('propertyGroups',{}).get('variations',{}).get('propertyNames',[])}
    print(pt,enum); time.sleep(0.5)
json.dump(res,open(f,'w'),indent=1)
