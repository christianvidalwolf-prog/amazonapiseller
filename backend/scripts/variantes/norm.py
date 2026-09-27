import re, unicodedata
COLORS="blanco blanca blancos blancas negro negra negros negras gris grises azul azules rojo roja rojos rojas verde verdes amarillo amarilla amarillos rosa rosas morado morada lila lilas naranja naranjas marron marrones beige crema dorado dorada dorados doradas plateado plateada plata oro cobre bronce transparente transparentes natural naturales turquesa burdeos granate mostaza camel taupe arena caqui kaki fucsia violeta celeste marino multicolor nude coral menta salmon terracota ocre champan champagne perla antracita topo visón vison ambar grafito cafe chocolate mint pastel oscuro oscura claro clara envejecido envejecida blanco/negro".split()
STOP={'de','del','la','el','los','las','con','para','y','en','a','e','un','una','o','x','cm','mm','ml','l','m','kg','g','por','al','set','pack','lote','juego','uds','ud','unidades','piezas','pzs','modelos','modelo','surtido','surtidos','surtidas','diseno','disenos','tamano','grande','pequeno','pequena','mediano','mediana','mini','xl','xxl','s','xs'}
BRANDS=r'^(rocking gifts|vidal ?regalos|dcasa|signes grimalt|home line)\s*-?\s*'
def strip_acc(s): return ''.join(c for c in unicodedata.normalize('NFD',s) if unicodedata.category(c)!='Mn')
def base(title):
    t=strip_acc(title.lower())
    t=re.sub(r'^\d{5,}[a-z]*\s+','',t)
    t=re.sub(BRANDS,'',t); t=re.sub(r'\s-\s\d+$','',t)
    t=re.split(r'\s[|,(]\s?|\s-\s',t)[0]      # corta tras primera cláusula
    t=re.sub(r'\d+([.,]\d+)?\s*(x\s*\d+([.,]\d+)?\s*)*(cm|mm|ml|l|m|kg|g|cl|\")?\b',' ',t)
    toks=[w for w in re.findall(r'[a-zñ]+',t) if w not in STOP and w not in COLORS and len(w)>1]
    return ' '.join(toks)
