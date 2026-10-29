# Familia "Perchas de pared de hierro colado ROCKING GIFTS": colgadores decorativos de un motivo (animales, faro,
# ancla, sol...). Tema STYLE_NAME/SIZE_NAME (motivo / medida), STORAGE_HOOK como B0CW6QYG5V (30343SG).
PRODUCT_TYPE = "STORAGE_HOOK"
THEME = "STYLE_NAME/SIZE_NAME"
MARKETS = {"ES": ("A1RKKUPIHCS9HS", "es_ES"), "DE": ("A1PA6795UKMFR9", "de_DE"), "FR": ("A13V1IB3VIYZZH", "fr_FR"), "IT": ("APJ6JRA9NG5V4", "it_IT")}
LIVE = "live_2026-10-29.json"

# motivo ES: (DE, FR, IT)
STYLE = {
    "Correa de perro, 3 ganchos": ("Hundeleine, 3 Haken", "Laisse de chien, 3 crochets", "Guinzaglio, 3 ganci"),
    "Paraguas": ("Regenschirm", "Parapluie", "Ombrello"),
    "Elefante": ("Elefant", "Éléphant", "Elefante"),
    "Perro": ("Hund", "Chien", "Cane"),
    "Gato": ("Katze", "Chat", "Gatto"),
    "Gatos": ("Katzen", "Chats", "Gatti"),
    "Gatos, 4 pomos": ("Katzen, 4 Knäufe", "Chats, 4 patères", "Gatti, 4 pomelli"),
    "Búho": ("Eule", "Hibou", "Gufo"),
    "Gallina": ("Huhn", "Poule", "Gallina"),
    "Pájaro": ("Vogel", "Oiseau", "Uccellino"),
    "Flamenco": ("Flamingo", "Flamant rose", "Fenicottero"),
    "Flamencos": ("Flamingos", "Flamants roses", "Fenicotteri"),
    "Tortuga": ("Schildkröte", "Tortue", "Tartaruga"),
    "Lagarto": ("Eidechse", "Lézard", "Lucertola"),
    "Libélula": ("Libelle", "Libellule", "Libellula"),
    "Mariposa": ("Schmetterling", "Papillon", "Farfalla"),
    "Sol": ("Sonne", "Soleil", "Sole"),
    "Faro y ancla": ("Leuchtturm und Anker", "Phare et ancre", "Faro e ancora"),
    "Barcos y faro": ("Boote und Leuchtturm", "Bateaux et phare", "Barche e faro"),
    "Ancla": ("Anker", "Ancre", "Ancora"),
    "Herradura": ("Hufeisen", "Fer à cheval", "Ferro di cavallo"),
}

# sku: (motivo, medida)
CHILDREN = {
    "30343SG": ("Correa de perro, 3 ganchos", "19 cm"),
    "30342SG": ("Paraguas", "13 cm"),
    "30344SG": ("Elefante", "13 cm"),
    "33628SGI": ("Perro", "14 cm"),
    "39819SGI": ("Gato", "12 cm"),
    "39813SGI": ("Gatos", "15,5 cm"),
    "39838SGI": ("Gatos, 4 pomos", "28 cm"),
    "36713SGI": ("Búho", "16 cm"),
    "36715SGI": ("Búho", "19x5x10 cm"),
    "39822SGI": ("Búho", "10x4x18 cm"),
    "36712SGI": ("Gallina", "11,5 cm"),
    "36718SGI": ("Gallina", "17 cm"),
    "39818SGI": ("Pájaro", "10 cm"),
    "35132SGI": ("Flamenco", "23x4x12 cm"),
    "35130SGI": ("Flamencos", "14x3x22 cm"),
    "36709SGI": ("Tortuga", "12,5 cm"),
    "39829SGI": ("Tortuga", "12x2,5x9,5 cm"),
    "36714SGI": ("Lagarto", "18 cm"),
    "39830SGI": ("Lagarto", "25 cm"),
    "39820SGI": ("Libélula", "20 cm"),
    "39823SGI": ("Mariposa", "13 cm"),
    "39804SGI": ("Sol", "16 cm"),
    "39828SGI": ("Faro y ancla", "13,5 cm"),
    "35129SGI": ("Barcos y faro", "16x4x25,5 cm"),
    "9203RGSG": ("Ancla", "16 cm"),
    "9194RGSG": ("Herradura", "18 cm"),
}

EXCLUDED = {
    "24212SG": "marca Vidal Regalos y oferta borrada en los 4 países",
    "24220SG": "marca Vidal Regalos",
}

# Familias anteriores con hijos que pasan a la nueva (no se borran).
OLD_PARENTS = ["PARENT-B282-PERCHAPAREDG"]

def style_name(sku, code):
    s = CHILDREN[sku][0]
    return s if code == "ES" else STYLE[s][("DE", "FR", "IT").index(code)]

def size_name(sku, code):
    return CHILDREN[sku][1]
