# Familia "Globos terráqueos ROCKING GIFTS" — tema SIZE_NAME/STYLE_NAME (diámetro / modelo), GLOBE.
# Reutiliza el SKU padre "globoterraqueo" (intento anterior, incompleto, ya existente en ES/DE/FR/IT).
PRODUCT_TYPE = "GLOBE"
THEME = "SIZE_NAME/STYLE_NAME"
MARKETS = {"ES": ("A1RKKUPIHCS9HS", "es_ES"), "DE": ("A1PA6795UKMFR9", "de_DE"), "FR": ("A13V1IB3VIYZZH", "fr_FR"), "IT": ("APJ6JRA9NG5V4", "it_IT")}

# sku: (diámetro, modelo ES, DE, FR, IT)
MODELS = {
    "255011DCI": ("10,8 cm", "Set de 3 vintage en tonos pastel", "3er-Set Vintage in Pastelltönen", "Lot de 3 vintage tons pastel", "Set da 3 vintage in tonalità pastello"),
    "255019DCI": ("10,8 cm", "Vintage con pie alto de metal", "Vintage mit hohem Metallfuß", "Vintage avec haut pied en métal", "Vintage con piede alto in metallo"),
    "255018DCI": ("11 cm", "Vintage mini de metal", "Vintage Mini aus Metall", "Vintage mini en métal", "Vintage mini in metallo"),
    "255013RGCLM": ("12,5 cm", "Vintage con base, modelo I", "Vintage mit Sockel, Modell I", "Vintage avec socle, modèle I", "Vintage con base, modello I"),
    "255014RGCLM": ("12,5 cm", "Vintage con base, modelo II", "Vintage mit Sockel, Modell II", "Vintage avec socle, modèle II", "Vintage con base, modello II"),
    "40053MDRG": ("14 cm", "Beige con luz, a pilas", "Beige mit Licht, batteriebetrieben", "Beige lumineux, à piles", "Beige con luce, a batteria"),
    "41020MD": ("14 cm", "Azul con luz LED, modelo I", "Blau mit LED-Licht, Modell I", "Bleu lumineux LED, modèle I", "Blu con luce LED, modello I"),
    "41288MD": ("14 cm", "Azul con luz LED, modelo II", "Blau mit LED-Licht, Modell II", "Bleu lumineux LED, modèle II", "Blu con luce LED, modello II"),
    "42574MD": ("14 cm", "Político azul con soporte negro", "Politisch blau mit schwarzem Ständer", "Politique bleu avec support noir", "Politico blu con supporto nero"),
    "42575MD": ("14 cm", "Beige con soporte negro", "Beige mit schwarzem Ständer", "Beige avec support noir", "Beige con supporto nero"),
    "42637MD": ("14 cm", "Negro con soporte cromado", "Schwarz mit verchromtem Ständer", "Noir avec support chromé", "Nero con supporto cromato"),
    "33692SGI": ("17,5 cm", "Arco dorado, PVC y metal", "Goldener Bogen, PVC und Metall", "Arc doré, PVC et métal", "Arco dorato, PVC e metallo"),
    "22992SG": ("20 cm", "Peana de metal, 32 cm de alto", "Metallsockel, 32 cm hoch", "Socle en métal, 32 cm de haut", "Base in metallo, 32 cm di altezza"),
    "255015RGCLM": ("20 cm", "Pie de metal dorado, modelo I", "Goldener Metallfuß, Modell I", "Pied en métal doré, modèle I", "Piede in metallo dorato, modello I"),
    "255016RGCLM": ("20 cm", "Pie de metal dorado, modelo II", "Goldener Metallfuß, Modell II", "Pied en métal doré, modèle II", "Piede in metallo dorato, modello II"),
    "255017DCI": ("20 cm", "Vintage de metal beige", "Vintage aus Metall, beige", "Vintage en métal beige", "Vintage in metallo beige"),
    "3147SG": ("20 cm", "Base de madera, modelo I", "Holzsockel, Modell I", "Socle en bois, modèle I", "Base in legno, modello I"),
    "3149SG": ("20 cm", "Base de madera, modelo II", "Holzsockel, Modell II", "Socle en bois, modèle II", "Base in legno, modello II"),
    "33700SGI": ("20 cm", "Vintage sepia con base de madera", "Vintage Sepia mit Holzsockel", "Vintage sépia avec socle en bois", "Vintage seppia con base in legno"),
    "255012DCI": ("25 cm", "Vintage con base de madera de mango", "Vintage mit Mangoholzsockel", "Vintage avec socle en bois de manguier", "Vintage con base in legno di mango"),
    "3145SG": ("25 cm", "Clásico", "Klassisch", "Classique", "Classico"),
}

CHILDREN = {sku: (m[1], m[0]) for sku, m in MODELS.items()}  # (modelo, tamaño) como en ../santos
STYLE = {m[1]: {"DE": m[2], "FR": m[3], "IT": m[4]} for m in MODELS.values()}

EXCLUDED = {
    "301902CLM": "título de globo pero viñetas de un pack de bolígrafos: ficha con datos mezclados",
    "18857SG": "marca Home Gadgets", "10127SG": "marca Art Deco Home", "3149SGFBA": "marca Art Deco Home (FBA)",
    "…CLMFBA": "SKU FBA del mismo ASIN que su FBM (la variación es por ASIN)",
    "archivados/borrados": "40 globos en la lista de borrado o ya borrados",
    "40056SGI, 24662SG, 57476SG": "esferas armilares y reloj de péndulo, no son globos",
}
