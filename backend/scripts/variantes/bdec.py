# Decisiones revisión visual grupos B
SKIP={'VAR-009':'bolsas regalo, diseños múltiples','VAR-014':'bolsas regalo','VAR-021':'bolsas regalo','VAR-030':'bolsas regalo','VAR-031':'cajas regalo','VAR-041':'tazas sets distintos','VAR-058':'mesas distintas','VAR-095':'mesas distintas'}
EXCL={'VAR-070':['36757SGI'],'VAR-072':['37478SGI'],'VAR-094':['36128SGI']}
SPLIT={'VAR-015':[['309434DCI','309435DCI','309441DCI','309438DCI','309437DCI'],['309448DCI','309452DCI','309453DCI'],['309469DCI','309471DCI','309468DCI']]}
NAMES={'VAR-069':{'34616':'Cubista','36610':'Flores Negro','37215':'Mandala','39994':'Noche Estrellada'},
       'VAR-060':{'30990':'Pastel','36169':'Mandala Rojo','37225':'Otoño','39990':'Colores Vivos'}}
MERGE={'VAR-065':('PARENT-MENINA-FIGURAMENINA','ROCKING GIFTS Figura Menina Decorativa de Resina - Varios Tamaños y Diseños',{'33771':'Mosaico Colores','37933':'Mosaico Corazones','33769':'Mosaico Patchwork','34716':'Dorada Mosaico'})}
LETTERS=['VAR-008']
EXCL.update({'VAR-125':['39909SGI']})
# merges into existing families (groups combined with originals; names for new children)
MERGE_EXIST={
 'esferico':(['VAR-110','VAR-123'],{'34139':'Azul Remolino','38394':'Azul Violeta','38409':'Naranja','35914':'Espiral Verde','38390':'Rayas Azules','38415':'Rosa Dorado'}),
 'v074':(['VAR-133'],{}),
 'v011':(['VAR-140'],{}),
 'elefante':(['VAR-141'],{}),
 'tortuga':(['VAR-142'],{}),
}
TETERAS_EXTRA={'39149SGI':['0,6 L','Amarillo Bambú'],'39182SGI':['1,2 L','Rojo Estriada'],'34194SGI':['0,7 L','Negro Ramas'],'34195SGI':['0,7 L','Rojo Flores Doradas'],'34180SGI':None,'34183SGI':None}
SKIP.update({'VAR-083':'calcetines, sin talla','VAR-158':'bolsas diseños mixtos','VAR-159':'bolsas'})
NAMES.update({'VAR-102':{'32990':'Mandala Pastel','37214':'Mandala','30989':'Azulejo'}})
MERGE_EXIST.update({'medusa':(['VAR-089'],{'12531':'Rosa Clara','35905':'Verde Menta'})})
EXCL.update({'VAR-089':['35906SGI']})
# merges among B groups: first id is base
MERGE_B=[['VAR-106','VAR-116'],['VAR-130','VAR-151'],['VAR-096','VAR-138'],['VAR-086','VAR-015#0']]
SKIP.update({'VAR-179':'tazas navidad iguales','VAR-180':'tazas navidad iguales','VAR-181':'cajas regalo','VAR-183':'papel regalo','VAR-184':'papel regalo','VAR-186':'calcetines','VAR-187':'calcetines'})
EXCL.update({'VAR-176':['272742DCI']})
MERGE_B+= [['VAR-160','VAR-161'],['VAR-081','VAR-174']]
SKIP.update({'VAR-214':'mesas distintas','VAR-215':'mesas distintas','VAR-216':'productos distintos','VAR-228':'perros mezclados'})
EXCL.update({'VAR-202':['34303SGI'],'VAR-226':['33183SGI']})
MERGE_EXIST['esferico'][0].append('VAR-224'); MERGE_EXIST['esferico'][1].update({'33025':'Ola Azul','35900':'Ola Turquesa'})
MERGE_EXIST['bulldog']=(['VAR-226','VAR-227'],{})
LAMP_EXTRA={'VAR-104':{'33054':'Globo Espiral','34092':'Globo Espiral Pequeño','39090':'Seta Blanca Mandala'},
            'VAR-239':{'34093':'Seta Espiral Tricolor','34095':'Seta Espiral Verde'},
            'VAR-240':{'34094':'Seta Escamas Colores','34111':'Seta Flores Verdes'}}
SKIP.update({'VAR-244':'distintos','VAR-245':'distintos','VAR-264':'vehículos distintos','VAR-276':'cestas distintas','VAR-283':'distintos','VAR-286':'distintos','VAR-287':'distintos'})
TETERAS_EXTRA.update({'34181SGI':['0,3 L','Verde Relieve'],'39184SGI':['1,2 L','Negro Estriada']})
SKIP.update({'VAR-306':'packs vehículos distintos','VAR-307':'packs vehículos distintos','VAR-308':'packs vehículos distintos','VAR-309':'distintos'})
NAMES.update({'VAR-302':{'37232':'Cuadrados','40289':'Forma Mariposa'}})
MERGE_B+= [['VAR-203','VAR-290'],['VAR-275','VAR-316'],['VAR-105','VAR-322'],['VAR-130','VAR-151','VAR-330']]
MERGE_B=[m for m in MERGE_B if m!=['VAR-130','VAR-151']]
MERGE_EXIST['bulldog'][0].extend(['VAR-313','VAR-333'])
MERGE_EXIST['elefante'][0].append('VAR-323')
MERGE_EXIST['v077']=(['VAR-334'],{})
EXCL.update({'VAR-334':['37945SGI']})
SKIP.update({'VAR-339':'distintos','VAR-353':'distintos','VAR-360':'teteras -> familia teteras'})
TETERAS_EXTRA.update({'39156SGI':['0,7 L','Negro Estriada']})
DUP_FLAG={'39159SGI':'posible duplicado de 39168SGI (tetera 0,8L negra puntos)','29424SGI':'duplicado de 34185SGI'}
MERGE_B+= [['VAR-057','VAR-364']]
SKIP.update({'VAR-390':'distintos','VAR-391':'distintos'})
MERGE_EXIST['v016']=(['VAR-392'],{})
MERGE_B+= [['VAR-396','VAR-397','VAR-398'],['VAR-402','VAR-403']]
NAMES.update({'VAR-396':{'40191':'Arcángel Dorado','40195':'Arcángel Dorado','40208':'Arcángel con Antorcha','40209':'Arcángel con Antorcha','40222':'Arcángel con Espada','40218':'Arcángel con Espada'},
              'VAR-402':{'40460':'Blanco y Negro','40461':'Naranja y Azul','40470':'Beige Dorado','40476':'Azul Espiral'}})
TOY_EXTRA=['VAR-406','VAR-409']
