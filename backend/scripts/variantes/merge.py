import csv, re, json, collections
ROOT="/Users/christianvidalwolf/AMAZON AWS SP-API"; ST="/Users/christianvidalwolf/Stock"
rows=list(csv.DictReader(open(f"{ROOT}/catalogo_completo.csv",encoding='utf-8-sig'),delimiter='\t'))
def sup(s):
    u=s.upper()
    if u.endswith('SGI'): return 'SG', s[:-3]
    if u.endswith('DCI'): return 'DC', s[:-3]
    if u.endswith('DC'): return 'DC', s[:-2]
    return None,None
# signes
sg={}
for r in csv.DictReader(open(f"{ST}/signes_stock.csv",encoding='latin-1'),delimiter=';'):
    c=r['Codigo'].replace('SG-','').strip(); sg[c]=r
dc={}
for r in csv.DictReader(open(f"{ST}/StockDcasa20260311.csv",encoding='latin-1'),delimiter=';'):
    dc[r['CODIGO'].strip()]=r
# sales units 2025+2026 by sku
sales=collections.Counter(); rev=collections.Counter()
for f in ['ventas_2025.csv','ventas_2026.csv']:
    for r in csv.DictReader(open(f"{ROOT}/{f}",encoding='utf-8-sig'),delimiter=';'):
        if r.get('order-status')=='Cancelled': continue
        try: q=int(r['quantity'] or 0); p=float(r['item-price'] or 0)
        except: continue
        sales[r['sku']]+=q; rev[r['sku']]+=p
out=[]; miss=collections.Counter()
for r in rows:
    s,code=sup(r['seller-sku'])
    if not s: continue
    t=r['item-name']
    m=re.match(r'^(ROCKING GIFTS|Vidal Regalos|dcasa|DCASA|Signes Grimalt|SIGNES GRIMALT)\s*-?\s*',t,re.I)
    brand=m.group(1).upper() if m else 'OTRA'
    d={'sku':r['seller-sku'],'asin':r['asin1'],'supplier':s,'code':code,'title':t,'brand':brand,
       'price':r['price'],'qty':r['quantity'],'status':r['status'],'open':r['open-date'],
       'units':sales[r['seller-sku']],'rev':round(rev[r['seller-sku']],2)}
    if s=='SG':
        x=sg.get(code)
        if x: d.update(sdesc=x['Descripcion'].strip(),cat=x['Categolria WEB'],sub=x['Tipo producto WEB'],coll=x['Colecci�n WEB'] if 'Colecci�n WEB' in x else x.get('Colecci\xf3n WEB',''),mat=x['Descripcion material'],feat=x['Caracteristicas)'],h=x['Altura'],w=x['Anchura'],l=x['Longitud'],set=x['Unidades SET'],sstock=x['Stock'])
        else: miss['SG']+=1
    else:
        x=dc.get(code)
        if x: d.update(sdesc=x['DESCRIPCION'].strip(),cat=x['Familia'],sub=x['SubFamilia'],coll=x['Tipo'],mat=x['MATERIAL'],models=x['MODELOS'],h=x['ALTO'],w=x['ANCHO'],l=x['LARGO'],sstock=x['STOCK_DISPONIBLE'])
        else: miss['DC']+=1
    out.append(d)
json.dump(out,open("/private/tmp/claude-501/-Users-christianvidalwolf-AMAZON-AWS-SP-API/85f1a885-b5c8-4c0b-bc52-4895a880be2b/scratchpad/items.json","w"),ensure_ascii=False)
print(len(out),miss,collections.Counter(d['brand'] for d in out))
print(sum(1 for d in out if d['units']>0),'skus con ventas', sum(d['units'] for d in out))
