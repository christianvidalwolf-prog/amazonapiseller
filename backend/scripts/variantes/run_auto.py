# Generic runner: families from groups_final (theme SIZE_NAME/COLOR_NAME, keep current productType, PATCH children)
import sys,json,re,collections,copy
S=sys.argv[1]; sys.path.insert(0,S)
from build import *
G={x['id']:x for x in json.load(open(f"{S}/groups_final.json"))}
spec=json.load(open(f"{S}/{sys.argv[2]}")); name=sys.argv[3]; mode=sys.argv[4]
g=spec[name]; theme='SIZE_NAME/COLOR_NAME'
def log(o): open(f"{S}/write_log.jsonl","a").write(json.dumps({"t":time.time(),**o},ensure_ascii=False)+"\n")
def sz(d):
    s=re.sub(r'(\d)x',r'\1 x ',d['dim'] or d['size']).replace('cm',' cm').replace('  ',' ').strip()
    return s+(f" (Pack x{d['pack']})" if d['pack']>1 else '')
items=[d for gid in g['groups'] for d in G[gid]['items'] if d['sku'] not in g.get('excluded',[]) and (not g.get('only_override') or d['sku'] in g['override'] or gid in g.get('free_groups',[])) and (not g.get('include') or d['sku'] in g['include']) and (gid!='VAR-015' or not g.get('include_extra') or d['sku'] in g['include_extra'])]
def ch(d):
    o=g.get('override',{}).get(d['sku'])
    if o: return (o[0] or sz(d),o[1])
    return (sz(d),d['color'] or d['colort'].title() or 'Multicolor')
children={d['sku']:ch(d) for d in items}
dup=[k for k,c in collections.Counter(children.values()).items() if c>1]
if dup: print(name,'DUP',dup); sys.exit(1)
full={s:get_full(s) for s in children}
pts={full[s]['summaries'][0]['productType'] for s in children}
if len(pts)>1: print(name,'MIXED PT',pts); sys.exit(1)
pt=pts.pop(); psku=g.get('parent_sku') or 'PARENT-'+name.upper()+'-'+re.sub(r'[^A-Z]','',g['title'].upper())[12:24]
rep=max(children,key=lambda s:int(G[g['groups'][0]]['items'][0]['qty'] or 0) if False else float(next(d for d in items if d['sku']==s)['qty'] or 0))
pbody=parent_payload(full[rep]['attributes'],pt,g['title'],theme,extra={k:[dict(x,marketplace_id=MP) for x in val] for k,val in g.get('child_extra',{}).items()} or None,
    main_image=(full[rep]['attributes'].get('main_product_image_locator') or [{}])[0].get('media_location'))
def patch(s,q):
    size,color=children[s]
    ex={'power_plug_type':full[s]['attributes'].get('power_plug_type') or v('no_plug')} if pt=='SCULPTURE' else {}
    ex.update({k:[dict(x,marketplace_id=MP) for x in val] for k,val in g.get('child_extra',{}).items()})
    return call("PATCH",s,{"productType":pt,"patches":child_patches(psku,theme,size=size,color=color,extra=ex)},q)
bad=[]
st,r=call("PUT",psku,pbody,{"mode":"VALIDATION_PREVIEW"})
if r.get('status')!='VALID': bad.append(('PARENT',[(i['code'],i['message'][:120]) for i in r.get('issues',[]) if i['severity']=='ERROR']))
for s in children:
    st,r=patch(s,{"mode":"VALIDATION_PREVIEW"})
    if r.get('status')!='VALID': bad.append((s,[(i['code'],i['message'][:120]) for i in r.get('issues',[]) if i['severity']=='ERROR']))
print(name,pt,psku,len(children),'hijos','OK' if not bad else f'FALLOS {bad[:4]}')
if mode=='submit':
    badsk={b[0] for b in bad}
    if 'PARENT' in badsk: sys.exit(1)
    st,r=call("PUT",psku,pbody); log({"op":"PUT parent","sku":psku,"group":name,"status":st,"resp":r})
    time.sleep(2); n=0
    for s in children:
        if s in badsk: continue
        st,r=patch(s,None); log({"op":"PATCH child","sku":s,"group":name,"size_color":children[s],"status":st,"resp":r}); n+=r.get('status')=='ACCEPTED'
    print('  enviado parent',r and 'ok',n,'hijos aceptados; omitidos',len(badsk))
