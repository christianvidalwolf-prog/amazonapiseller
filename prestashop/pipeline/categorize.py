"""Asigna a cada producto la categoría hoja más adecuada del árbol "Catálogo" (id 82).

Gana la regla cuya coincidencia aparece antes en el título (el sustantivo principal suele
ir primero); a igual posición, gana la regla listada antes. Sin coincidencia en el título
se prueba el subtítulo; si tampoco, va a FALLBACK y se marca para revisión manual.
"""
from pathlib import Path
import json, os, re, unicodedata, collections

OUT = Path(__file__).resolve().parent.parent / 'data'
PRODUCTS = OUT / os.getenv('PS_PRODUCTS', 'products.json')
FALLBACK = 46  # Decoracion > Objetos Decorativos

PARENT = {**{i: 12 for i in range(22, 26)}, **{i: 13 for i in range(26, 36)},
          **{i: 15 for i in range(36, 50)}, 50: 16, 51: 17, 52: 18, 53: 18,
          **{i: 19 for i in range(54, 70)}, **{i: 20 for i in range(70, 81)}, 81: 21}

# (regex sobre texto sin acentos en minúsculas, id_category)
RULES = [
    # frases específicas antes que palabras sueltas
    (r'\b(cinta|cordon|funda|correa)\b[^,]*\bmovil', 62),
    (r'\bfunda (de )?tablet', 62),
    (r'\bjuego de (domino|ajedrez|mesa(?! comedor)|cartas|dados|parchis|damas|naipes|backgammon)', 65),
    (r'\b(domino|ajedrez|parchis|naipes|puzzle|rompecabezas|backgammon)\b', 65),
    (r'\bbolsas? (de )?(papel )?(regalo|kraft)|\bbolsas? (de )?papel\b', 54),
    (r'\bpapel (de )?regalo', 54),
    (r'\bcinta (decorativa|regalo)', 54),
    (r'\breloj(es)? (de )?pared', 48),
    (r'\bglobos? terraqueo', 43),
    (r'\bpantalla (de )?lampara|\blamparas?\b|\bflexo\b|\baplique\b|\bfarol(illo)?s?\b|\bguirnalda (de )?luz|\bluz led\b', 44),
    (r'\bbajo ?platos?\b', 31),
    (r'\bbarras? (de )?cortina', 36),
    (r'\bcaminos? de mesa', 27),
    (r'\bjuego de mesa comedor|\bmesa comedor', 78),
    (r'\breposacucharas|\bcubre ?alimentos', 27),
    (r'\blecheras?\b', 31),
    (r'\bcajoner[oa]s?\b', 78),
    (r'\bfel ?pudos?\b', 77),
    (r'\blaberinto', 65),
    (r'\bjuego (de )?bano', 22),
    (r'\blimas? (de )?unas|\bcortaunas', 25),
    (r'\bbascula|\buntador|\btijeras (de )?cocina|\bestropajer|\bfiltro\b|\bcubitera|\bmantequillera|\bpaletas? (de )?cocina|\bescurreplatos|\bcubertero|\bpanera|\bbombonera|\brejilla|\bcarros? (auxiliar )?(de )?cocina|\bcarro auxiliar cocina|\bcopas?\b|\butensilios?\b|\brallador|\bexprimidor|\bmortero', 27),
    (r'\bsacos? (de )?regalo|\betiquetas? (de )?regalo|\bcalendario (de )?adviento', 54),
    (r'\bportatodos?\b|\bmarcadores\b|\bplanificador|\bbloc\b|\bjuego de escritura|\bcalendario', 52),
    (r'\bcintas? (para el )?pelo|\bdiademas?\b|\bpasadores?\b|\bcoleteros?\b', 67),
    (r'\bbaston(es)?\b|\bcalzador(es)?\b', 58),
    (r'\bcajitas?\b|\bbotiquin', 38),
    (r'\bletreros?\b', 40),
    (r'\bescritorios?\b', 78),
    (r'\bpongotodos?\b|\bburletes?\b|\bcortavientos\b', 36),
    (r'\bcencerros?\b', 46),
    (r'\bdispensador(es)? (de )?jabon|\bjaboneras?\b|\bescobilleros?\b|\bportarrollos\b|\btoalleros?\b|\bvasos? (de )?bano', 22),
    (r'\bneceser(es)?\b|\bbolsa (de )?aseo', 23),
    (r'\btoallas?\b|\balfombra (de )?bano', 23),
    (r'\bpastilleros?\b', 25),
    (r'\babridor(es)?\b|\babrebotellas\b', 26),
    (r'\bsacacorchos\b|\bbotelleros?\b|\bdecantador\b|\bcopas? (de )?vino|\bvino\b', 81),
    (r'\baceiteras?\b|\bvinagreras?\b|\bconvoy\b', 28),
    (r'\bbandejas?\b', 29),
    (r'\bbotes?\b|\btarros?\b|\bgalleteros?\b|\bcontenedor(es)?\b|\bazucareros?\b', 30),
    (r'\bespecieros?\b', 32),
    (r'\bservilletas?\b', 33),
    (r'\btazas?\b|\bmugs?\b', 34),
    (r'\bteteras?\b|\bcafeteras?\b', 35),
    (r'\bindividual(es)?\b|\bmantel(es)?\b|\bsalvamantel(es)?\b|\bposavasos\b|\bdelantal(es)?\b|\bpanos?\b|\bmanoplas?\b|\btablas? (de )?cortar|\bcubiertos\b|\bneveras?\b|\btermos?\b|\bfiambreras?\b|\bservilleteros?\b', 27),
    (r'\bplatos?\b|\bcuencos?\b|\bbol(es)?\b|\bensaladeras?\b|\bjarras?\b|\bfruteros?\b|\bsaleros?\b|\bvasos?\b|\bbotellas? (de )?acero|\bbotellas? (de )?agua|\bfuentes? (de )?(horno|servir)|\btablas?\b|\bcucharas?\b', 31),
    (r'\bcenicero|\bpitillera|\bmechero|\bpipas? (de )?(madera|brezo|metal|fumar)|\bpipa falcon|\brascador(es)? (de )?pipa', 37),
    (r'\bjoyeros?\b|\bcostureros?\b', 60),
    (r'\bdedal(es)?\b', 61),
    (r'\bcajas?\b|\bestuches?\b', 38),
    (r'\bcuadros?\b|\blienzos?\b|\blaminas?\b', 39),
    (r'\bplacas?\b|\bcartel(es)?\b|\bletras?\b|\bvinilos?\b|\bmovil(es)? (de )?pared|\bdecoracion (de )?pared', 40),
    (r'\bespejos?\b', 41),
    (r'\bjarron(es)?\b|\bfloreros?\b', 45),
    (r'\bportavelas\b|\bcandelabros?\b|\bcandel\b|\bcandelero|\bfaroles? (de )?vela', 73),
    (r'\bvelas?\b', 49),
    (r'\bportafotos\b|\bmarcos? (de )?fotos?|\bmarcos?\b|\balbum(es)?\b', 50),
    (r'\bminerales?\b|\bcuarzo\b|\bamatista\b|\bgeoda\b|\bchakras?\b|\bchacras?\b', 51),
    (r'\bpisapapel(es)?\b', 53),
    (r'\blibretas?\b|\bcuadernos?\b|\bsobres?\b|\bboligrafos?\b|\blapiz\b|\blapices\b|\bdiarios?\b|\btarjetas?\b|\bagendas?\b|\bpostal(es)?\b|\bestuche escolar|\bmarcapaginas\b|\bportalapices\b', 52),
    (r'\bpulseras?\b|\bpendientes\b|\bcollar(es)?\b|\banillos?\b|\bbroches?\b|\bcolgante\b[^,]*\b(plata|cadena|acero)', 56),
    (r'\bbrujulas?\b|\bsextante\b|\balidada\b|\btelescopio\b|\bcatalejo\b', 57),
    (r'\bllaveros?\b', 66),
    (r'\bpanuelos?\b|\bfoulard\b', 68),
    (r'\bcalcetines\b|\bzapatillas\b|\bpijamas?\b|\bjersey\b|\bcalzoncillos\b|\bcaftan\b|\bpareos?\b|\bbolsos?\b|\bmonederos?\b|\bmochilas?\b|\bcarteras?\b|\bbolsas?\b|\bgorros?\b|\bbufandas?\b|\bguantes\b|\babanicos?\b|\bparaguas\b|\bsombrillas?\b|\bsombreros?\b|\bkimono\b|\bvestidos?\b|\btoallas? (de )?playa', 67),
    (r'\bpeluches?\b|\bmunec[oa]s?\b', 69),
    (r'\bhuchas?\b|\bset regalo\b|\bcaja regalo\b', 54),
    (r'\baltavoz|\bauriculares?|\bcargador|\bpower ?bank|\bsoporte (de )?movil|\bfunda\b[^,]*\bmovil', 62),
    (r'\bquemador(es)?\b|\bincienso\b|\bincensarios?\b|\bambientador(es)?\b|\bmikado\b|\bdifusor(es)?\b|\bsahumerio', 71),
    (r'\bbaul(es)?\b', 72),
    (r'\bpercheros?\b', 80),
    (r'\bperchas?\b|\bcolgador(es)?\b|\bganchos?\b', 74),
    (r'\bfelpudos?\b', 77),
    (r'\bparagueros?\b|\brevisteros?\b', 79),
    (r'\bmuebles?\b|\bmesas?\b|\bmesitas?\b|\bestanterias?\b|\bpuffs?\b|\bescaleras?\b|\btaburetes?\b|\bzapateros?\b|\bconsolas?\b|\bcomodas?\b|\bsillas?\b|\bbancos?\b|\bbutacas?\b|\bbiombos?\b|\bcarritos?\b', 78),
    (r'\breloj(es)?\b|\bdespertador(es)?\b', 47),
    (r'\bmantas?\b|\bplaids?\b|\bcojin(es)?\b|\bfundas? (de )?cojin|\balfombras?\b|\bcortinas?\b|\bcestas?\b|\bcestos?\b|\bpapeleras?\b|\borganizador(es)?\b|\bsujetapuertas\b|\bpomos?\b|\btirador(es)?\b|\bbuzon(es)?\b|\bfundas?\b|\bexpositor(es)?\b|\bmaceteros?\b|\bmacetas?\b|\bcolchas?\b|\bedredon', 36),
    (r'\bfiguras?\b|\bbustos?\b|\besculturas?\b|\bestatuas?\b|\bestatuillas?\b|\bnacimiento\b|\bbelen\b|\bcoches?\b|\bfurgonetas?\b|\bmotos?\b|\bavionetas?\b|\baviones?\b|\bscooter\b|\bbicicletas?\b|\bbarcos?\b|\bvelero\b|\btren\b|\bcamion\b|\bangel(es)?\b|\bbudas?\b|\bganesha\b|\belefantes?\b|\bbuhos?\b|\bgatos?\b|\bperros?\b|\bcaballos?\b|\bpez\b|\bpeces\b', 42),
    (r'\badornos?\b|\bbolas?\b|\bcampanas?\b|\bcorazon(es)?\b|\bestrellas?\b|\bramas?\b|\bflor(es)? artificial|\bplantas? artificial|\bmovil(es)?\b|\bcolgantes?\b|\batrapasuenos\b|\bfuentes?\b|\bbotellas?\b|\bcarillon|\bcampana de viento|\bmolinillo|\bcatavientos|\bdecorativ[oa]s?\b', 46),
]
COMPILED = [(re.compile(rx), cid) for rx, cid in RULES]


def norm(s):
    s = unicodedata.normalize('NFKD', s.lower())
    return ''.join(c for c in s if not unicodedata.combining(c))


def classify(text):
    best = None
    for order, (rx, cid) in enumerate(COMPILED):
        m = rx.search(text)
        if m and (best is None or (m.start(), order) < best[:2]):
            best = (m.start(), order, cid, m.group(0))
    return best


def run():
    products = json.loads(PRODUCTS.read_text())
    cats = {int(c['id']): c['name'][0]['value'] for c in json.loads((OUT / 'categories_raw.json').read_text())['result']}
    rows, counts, review = [], collections.Counter(), []
    for p in products:
        hit, via = classify(norm(p['name'])), 'titulo'
        if not hit:
            hit, via = classify(norm(p['subtitle'] + ' ' + p['description'][:200])), 'subtitulo'
        if hit:
            cid, kw = hit[2], hit[3]
        else:
            cid, kw, via = FALLBACK, '', 'fallback'
            review.append(p['reference'])
        if cid == FALLBACK and p.get('manufacturer') == 'Mineral Import':
            cid, via = 51, via + '+mineral_import'  # piedras, drusas, péndulos... -> Minerales
        p['id_category'] = cid
        p['category_path'] = f"{cats[PARENT[cid]]} > {cats[cid]}"
        p['extra_category_ids'] = [PARENT[cid]]
        p['category_match'] = f'{via}:{kw}'
        counts[p['category_path']] += 1
        rows.append(p)
    PRODUCTS.write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    by_via = collections.Counter(p['category_match'].split(':')[0] for p in rows)
    print('asignacion:', dict(by_via))
    for path, n in counts.most_common():
        print(f'{n:5}  {path}')
    return rows


if __name__ == '__main__':
    run()
