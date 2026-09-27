# Decisiones revisión visual grupos C
SKIP={'VAR-230':'distintos','VAR-248':'distintos','VAR-320':'distintos','VAR-340':'packs distintos','VAR-341':'distintos','VAR-347':'distintos','VAR-381':'campanas menina distintas','VAR-422':'CRAFT_WOOD','VAR-435':'distintos'}
EXCL={}
NAMES={}
MERGE_C=[['VAR-259','VAR-260']]
# into existing families: key -> (batch file, key, [groups], {code:name})
MERGE_EXIST={'v032':('batch2.json','v032',['VAR-208'],{}),'v036':('batch2.json','v036',['VAR-233'],{}),
 'b106':('batchB.json','b106',['VAR-234'],{}),'v011':('batch2.json','v011',['VAR-255'],{}),
 'esferico':('batch3.json','esferico',['VAR-400','VAR-401'],{'40344':'Flor Roja','35899':'Flor Azul','40382':'Flor Azul y Blanca','38422':'Medusa Rosa'}),
 'b008':('batchB.json','b008',['VAR-421'],{})}
LETTERS={'2182234':'F','2182250':'U'}
TETERAS={'39180SGI':['1,2 L','Negro Puntos'],'34182SGI':['0,3 L','Azul Flores']}
SKIP['VAR-361']='teteras -> familia teteras'
SKIP.update({'VAR-437':'distintos','VAR-443':'distintos','VAR-471':'distintos','VAR-474':'distintos','VAR-475':'packs','VAR-476':'packs','VAR-477':'tazas iguales','VAR-482':'distintos','VAR-486':'distintos','VAR-497':'distintos'})
NAMES.update({'VAR-456':{'271441':None}})
SKIP['VAR-456']='mismo código duplicado'
MERGE_EXIST['b369']=('batchB.json','b369',['VAR-496'],{})
for g in ['VAR-508','VAR-514','VAR-515','VAR-546']: SKIP[g]='calcetines sin talla'
for g in ['VAR-509','VAR-510','VAR-511','VAR-512','VAR-513']: SKIP[g]='zapatillas sin talla'
SKIP.update({'VAR-521':'distintos','VAR-559':'distintos','VAR-572':'distintos','VAR-578':'distintos','VAR-579':'distintos','VAR-583':'distintos','VAR-584':'distintos','VAR-587':'distintos'})
MERGE_EXIST['b087']=('batchB.json','b087',['VAR-573'],{'33472':'Dorado','33470':'Cobre Grabado'})
MERGE_EXIST['b096']=('batchB.json','b096',['VAR-582'],{'36393':'Retrato Doble','36396':'Retrato Colores'})
