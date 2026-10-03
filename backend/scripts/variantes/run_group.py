import sys,json,copy,re
S=sys.argv[1]; sys.path.insert(0,S)
from build import *
spec=json.load(open(f"{S}/pilot_spec.json")); G={x['id']:x for x in json.load(open(f"{S}/groups_final.json"))}
name=sys.argv[2]; mode=sys.argv[3]  # preview | submit
g=spec[name]
def log(o): open(f"{S}/write_log.jsonl","a").write(json.dumps({"t":time.time(),**o},ensure_ascii=False)+"\n")
# children mapping
if 'children' in g: children={k:tuple(v) for k,v in g['children'].items()}
else:
    x=G[g['group']]; children={}
    for d in x['items']:
        if d['sku'] in g.get('excluded',{}): continue
        a=json.loads(json.dumps(d))
        size=re.sub(r'(\d)x',r'\1 x ',d['dim'] or d['size']).replace('cm',' cm').replace('  ',' ').strip()
        if d['pack']>1: size+=f" (Pack x{d['pack']})"
        children[d['sku']]=(size,d['color'] or d['colort'].title())
    dup=[k for k,c in __import__('collections').Counter(children.values()).items() if c>1]
    if dup: print('DUP combos',dup); sys.exit(1)
pt=g['productType_target']; theme=g['theme']; psku=g.get('parent_sku') or 'PARENT-'+name.upper()
title=g.get('title') or G[g['group']]['ptitle'].replace('Varios Tamaños y Varios Colores','Varios Tamaños y Colores')
full={s:get_full(s) for s in children}
extra={'number_of_sets':v(1)} if pt=='TEAPOT' else {}
if pt=='LAMP':
    extra={'power_source_type':vl('Eléctrico con cable'),'is_fragile':v(True),'included_components':vl('Lámpara de mosaico con cable'),'power_plug_type':v('type_c_2pin_eu'),'accepted_voltage_frequency':v('220v_240v_50hz')}
if pt=='WIND_CHIME':
    extra={'is_fragile':v(True)}
if pt=='STORAGE_RACK':
    extra={'unit_count':[{"value":1,"type":{"language_tag":"es_ES","value":"unidad"},"marketplace_id":MP}],
           'included_components':vl('Especiero de madera con cajones de cerámica')}
def child_body(s):
    a=copy.deepcopy(full[s]['attributes'])
    if full[s]['summaries'][0]['productType']!=pt: a.pop('power_plug_type',None)
    a.update(copy.deepcopy(extra))
    if pt=='TRIVET':
        sib=next((full[o]['attributes'] for o in children if full[o]['summaries'][0]['productType']==pt),{})
        for k in ('is_fragile','item_length_width_thickness'):
            if k not in a and k in sib: a[k]=copy.deepcopy(sib[k])
        if 'is_fragile' not in a: a['is_fragile']=v('cerámica' in (full[s]['summaries'][0].get('itemName') or '').lower() or 'ceramica' in (full[s]['summaries'][0].get('itemName') or '').lower())
        if 'item_length_width_thickness' not in a and a.get('item_depth_width_height'):
            d=a['item_depth_width_height'][0]; dd=sorted([d['depth'],d['width'],d['height']],key=lambda x:x['value'])
            a['item_length_width_thickness']=[{"length":dd[2],"width":dd[1],"thickness":dd[0],"marketplace_id":MP}]
    if pt=='WIND_CHIME' and 'item_length_width_height' not in a and a.get('item_depth_width_height'):
        d=a['item_depth_width_height'][0]
        a['item_length_width_height']=[{"length":d['depth'],"width":d['width'],"height":d['height'],"marketplace_id":MP}]
    if pt=='STORAGE_RACK': a['model_name']=vl('Especiero '+children[s][0]+' '+children[s][1])
    if pt=='SCULPTURE':
        if 'power_plug_type' not in a:
            a['power_plug_type']=v('no_plug')
    size,color=children[s]
    a['parentage_level']=v('child'); a['child_parent_sku_relationship']=[{"child_relationship_type":"variation","parent_sku":psku,"marketplace_id":MP}]
    a['variation_theme']=[{"name":theme,"marketplace_id":MP}]; a['brand']=vl('ROCKING GIFTS')
    a['size']=vl(size); a['color']=vl(color)
    return {"productType":pt,"requirements":"LISTING","attributes":a}
# representative child = cheapest active
rep=next(iter(children))
pbody=parent_payload(full[rep]['attributes'],pt,title,theme,extra=copy.deepcopy(extra) or None,
     main_image=(full[rep]['attributes'].get('main_product_image_locator') or [{}])[0].get('media_location'))
ok=True
def show(tag,st,r):
    global ok
    errs=[(i['code'],i['message'][:140],i.get('attributeNames')) for i in r.get('issues',[]) if i['severity']=='ERROR']
    if st!=200 or r.get('status') not in ('VALID','ACCEPTED') or errs: ok=False; print(' ✗',tag,st,r.get('status'),errs[:3])
    return errs
st,r=call("PUT",psku,pbody,{"mode":"VALIDATION_PREVIEW"}); show('PARENT',st,r)
def send(s,preview):
    cur=full[s]['summaries'][0]['productType']
    q={"mode":"VALIDATION_PREVIEW"} if preview else None
    if cur==pt:
        size,color=children[s]
        ex={'power_plug_type':full[s]['attributes'].get('power_plug_type') or v('no_plug')} if pt=='SCULPTURE' else {}
        return "PATCH",call("PATCH",s,{"productType":pt,"patches":child_patches(psku,theme,size=size,color=color,extra=ex)},q)
    return "PUT",call("PUT",s,child_body(s),q)
for s in children:
    m,(st,r)=send(s,True); show(s,st,r)
print(name,'preview',"OK" if ok else "FALLOS",len(children),'hijos',pt,theme,'|',title)
if mode=='submit' and ok:
    st,r=call("PUT",psku,pbody); log({"op":"PUT parent","sku":psku,"group":name,"status":st,"resp":r}); print('parent',st,r.get('status'))
    time.sleep(3)
    for s in children:
        m,(st,r)=send(s,False); log({"op":m+" child","sku":s,"group":name,"size_color":children[s],"status":st,"resp":r})
        if r.get('status')!='ACCEPTED': print(' child',s,st,r.get('status'),r.get('issues'))
    print(name,'ENVIADO')
