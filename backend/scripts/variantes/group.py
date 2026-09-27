import json, re, collections, sys
sys.path.insert(0, sys.argv[1]); from norm import base, strip_acc, COLORS
S=sys.argv[1]
items={d['sku']:d for d in json.load(open(f"{S}/items.json"))}
L=[json.loads(l) for l in open(f"{S}/listings_cache.jsonl")]
themes=json.load(open(f"{S}/themes.json"))
def av(a,k):
    v=a.get(k);
    if not v: return ''
    x=v[0]; return str(x.get('value', x.get('name','')))
rg=[]; excl=collections.Counter()
for x in L:
    a=x.get('attrs') or {}
    b=av(a,'brand')
    if x['http']!=200: excl['error http']+=1; continue
    if not b: excl['sin contenido propio (ASIN ajeno)']+=1; continue
    if b.upper()!='ROCKING GIFTS': excl['marca '+b]+=1; continue
    if av(a,'parentage_level'): excl['ya en variación ('+av(a,'parentage_level')+')']+=1; continue
    d=dict(items[x['sku']]); d.update(pt=x['productType'],asin=x['asin'],name=x['itemName'] or d['title'],brand_raw=b,
      color=av(a,'color'),size=av(a,'size'),mat=av(a,'material'),nitems=av(a,'number_of_items'),ipq=av(a,'item_package_quantity'),
      buyable='BUYABLE' in (x.get('status') or []),image=x.get('image'))
    rg.append(d)
# pack / models from title
def parse(d):
    t=strip_acc(d['name'].lower())
    m=re.search(r'\bx\s?(\d+)\b',t); d['pack']=int(m.group(1)) if m and 'modelo' not in t[m.end():m.end()+10] else 1
    d['models']=bool(re.search(r'x\s?\d+\s+modelos|surtid',t))
    dims=re.findall(r'\d+(?:[.,]\d+)?(?:\s*x\s*\d+(?:[.,]\d+)?)*\s*(?:cm|mm|ml|l|cl)\b',t)
    d['dim']=dims[-1].replace(' ','') if dims else ''
    d['colort']=' '.join(w for w in re.findall(r'[a-z]+',t) if w in COLORS)
for d in rg: parse(d)
# group: productType + base
g=collections.defaultdict(list)
EXTRA={'decorativo','decorativa','decorativos','decorativas','adorno','adornos','estilo','regalo','ideal','hogar','casa','salon','dormitorio','cocina','mesa','pared','sobremesa','bonito','bonita','original','diseno','forma'}
def key(n):
    t=[w for w in base(n).split() if w not in EXTRA]
    return ' '.join(sorted(set(t)))
for d in rg: g[(d['pt'],key(d['name']))].append(d)
G=g
groups=[]
for k,v in G.items():
    if len(v)<2: continue
    allowed=set(themes.get(k[0],{}).get('themes') or [])
    SZ=lambda d:(d['dim'] or d['size']).lower(); CL=lambda d:(d['color'] or d['colort']).lower(); PK=lambda d:d['pack']
    ds=len({SZ(d) for d in v})>1; dc=len({CL(d) for d in v})>1; dp=len({PK(d) for d in v})>1
    dims=[x for x,flag in (('SIZE',ds),('COLOR',dc)) if flag]
    def dupcount(fs):
        c=collections.Counter(tuple(f(d) for f in fs) for d in v); return sum(n-1 for n in c.values() if n>1)
    fmap={'SIZE':lambda d:(SZ(d),PK(d)),'COLOR':CL,'STYLE':lambda d:d['sku']}
    cand=[]
    if len(dims)==2: cand=[('SIZE','COLOR')]
    elif dims: cand=[(dims[0],)]
    elif dp: cand=[('NUMBER_OF_ITEMS',)]; fmap['NUMBER_OF_ITEMS']=PK
    else: cand=[]
    th=cand[0] if cand else ()
    dup=dupcount([fmap[x] for x in th]) if th else len(v)
    if dup:  # hay diseños distintos con mismos valores -> añadir STYLE
        th=('SIZE','STYLE') if 'SIZE' in th else (('COLOR','STYLE') if 'COLOR' in th else ('STYLE',))
        if 'COLOR' in dims and 'SIZE' in dims: th=('SIZE','STYLE'); note='color va en STYLE_NAME'
    names={'SIZE':'SIZE_NAME','COLOR':'COLOR_NAME','STYLE':'STYLE_NAME','NUMBER_OF_ITEMS':'NUMBER_OF_ITEMS'}
    theme='/'.join(names[x] for x in th)
    alt=[theme, theme.replace('_NAME',''), '/'.join(reversed(theme.split('/')))]
    ok_theme=next((x for x in alt if x in allowed), None)
    th=theme
    prices=[float(d['price'] or 0) for d in v if d['price']]
    groups.append(dict(pt=k[0],key=k[1],n=len(v),theme=ok_theme or th,dup=dup,ok_theme=bool(ok_theme),need_style=('STYLE' in th),packvar=dp,
        pmin=min(prices) if prices else 0,pmax=max(prices) if prices else 0,active=sum(d['status']=='Active' for d in v),
        units=sum(d['units'] for d in v),suppliers=''.join(sorted({d['supplier'] for d in v})),items=v))
groups.sort(key=lambda x:-x['n'])
json.dump(dict(groups=groups,excl=excl,total_rg=len(rg)),open(f"{S}/groups.json","w"),ensure_ascii=False,default=str)
print('RG elegibles',len(rg),'excluidos',dict(excl))
print('grupos',len(groups),'skus agrupados',sum(x['n'] for x in groups))
print(collections.Counter(x['theme'] for x in groups))
print('theme no permitido',[(x['pt'],x['theme']) for x in groups if not x['ok_theme']][:30])
print('dups',sum(1 for x in groups if x['dup']))
