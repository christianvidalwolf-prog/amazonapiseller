import "dotenv/config";
import { SpApiClient } from "../src/spapi/client";
import { env } from "../src/config/env";
import { EU_MARKETPLACES } from "../src/modules/account-health/account-health.service";

const LOCALES: Record<string, string> = {
  ES: "es_ES",
  DE: "de_DE",
  FR: "fr_FR",
  IT: "it_IT",
  NL: "nl_NL",
};

async function publishAllMarketplaces() {
  const client = new SpApiClient({ credentials: env.spApi });
  const countries = ["ES", "DE", "FR", "IT", "NL"];

  // 1. BUNDLE-COCINA-SAL-AZUC
  console.log("\n========================================================");
  console.log("PUBLICANDO: BUNDLE-COCINA-SAL-AZUC en ES, DE, FR, IT, NL");
  console.log("========================================================");

  const cocinaTitles: Record<string, string> = {
    ES: "ROCKING GIFTS Set Cocina y Mesa: Salero Acrílico 10cm + Azucarero con Tapa de Acero Inoxidable y Cuchara - Diseño Moderno",
    DE: "ROCKING GIFTS Küchen-Set: Acryl-Salzstreuer 10cm + Zuckerdose mit Edelstahldeckel und Löffel - Modernes Design",
    FR: "ROCKING GIFTS Ensemble Cuisine & Table : Salière Acrylique 10cm + Sucrier avec Couvercle Inox et Cuillère - Design Moderne",
    IT: "ROCKING GIFTS Set Cucina e Tavola: Saliera Acrilica 10cm + Zuccheriera con Coperchio in Acciaio Inox e Cucchiaino - Design Moderno",
    NL: "ROCKING GIFTS Keukenset: Acryl Zoutstrooier 10cm + Suikerpot met RVS Deksel en Lepel - Modern Design",
  };

  const cocinaBullets: Record<string, string[]> = {
    ES: [
      "SET COMPLETO DE MESA: Incluye 1 salero acrílico de 10 cm y 1 azucarero de diseño contemporáneo con tapa protectora y cucharilla.",
      "MATERIALES DE ALTA CALIDAD: Acrílico transparente ultrarresistente y acero inoxidable anticorrosión aptos para uso alimentario.",
      "DISEÑO ELEGANTE: Ideal para vestir la mesa en el día a día o en reuniones familiares con un toque sobrio y práctico.",
      "FÁCIL LIMPIEZA Y RELLENO: Boca ancha para un rellenado limpio y dosificación precisa sin atascos."
    ],
    DE: [
      "KOMPLETTES TISCHSET: Enthält 1 transparenten Acryl-Salzstreuer (10 cm) und 1 moderne Zuckerdose mit Deckel und Löffel.",
      "HOCHWERTIGE MATERIALIEN: Robustes, lebensmittelechtes Acryl und rostfreier Edelstahl für lange Haltbarkeit.",
      "ELEGANTES DESIGN: Perfekt für den täglichen Gebrauch in Küche und Esszimmer oder für festliche Anlässe.",
      "LEICHT ZU REINIGEN: Breite Öffnung für einfaches Nachfüllen und saubere Dosierung."
    ],
    FR: [
      "ENSEMBLE COMPLET DE TABLE : Comprend 1 salière acrylique transparente (10 cm) et 1 sucrier moderne avec couvercle et cuillère.",
      "MATÉRIAUX DURABLES : Acrylique haute résistance et acier inoxydable de qualité alimentaire.",
      "DESIGN ÉLÉGANT : Parfait pour le quotidien ou pour recevoir avec une touche raffinée sur votre table.",
      "FACILE À REMPLIR : Ouverture pratique pour un dosage précis et un entretien aisé."
    ],
    IT: [
      "SET TAVOLA COMPLETO: Include 1 saliera in acrilico da 10 cm e 1 zuccheriera moderna con coperchio e cucchiaino.",
      "MATERIALI DUREVOLI: Acrilico trasparente resistente e acciaio inox per alimenti, igienico e solido.",
      "DESIGN MODERNO: Ideale per impreziosire la tavola ogni giorno o durante cene con ospiti.",
      "FACILE DA PULIRE: Apertura comoda per un riempimento rapido e un dosaggio impeccabile."
    ],
    NL: [
      "COMPLETE TAFELSET: Bevat 1 transparante acryl zoutstrooier (10 cm) en 1 moderne suikerpot met deksel en lepel.",
      "KWALITEITSMATERIALEN: Stevig acryl en roestvrij staal van voedselkwaliteit voor langdurig gebruik.",
      "MODERN DESIGN: Praktisch en stijlvol voor elke maaltijd of gezellige dinertjes.",
      "EENVOUDIG TE REINIGEN: Brede opening voor gemakkelijk bijvullen en doseren."
    ]
  };

  const cocinaColors: Record<string, string> = {
    ES: "Transparente / Plata",
    DE: "Transparent / Silber",
    FR: "Transparent / Argent",
    IT: "Trasparente / Argento",
    NL: "Transparant / Zilver",
  };

  const cocinaComponents: Record<string, string[]> = {
    ES: ["1 Salero acrílico", "1 Azucarero con tapa y cuchara"],
    DE: ["1 Acryl-Salzstreuer", "1 Zuckerdose mit Deckel und Löffel"],
    FR: ["1 Salière acrylique", "1 Sucrier avec couvercle et cuillère"],
    IT: ["1 Saliera acrilica", "1 Zuccheriera con coperchio e cucchiaino"],
    NL: ["1 Acryl zoutstrooier", "1 Suikerpot met deksel en lepel"],
  };

  for (const c of countries) {
    const mpInfo = EU_MARKETPLACES[c];
    const loc = LOCALES[c];
    const payload = {
      productType: "HOME_FURNITURE_AND_DECOR",
      requirements: "LISTING",
      attributes: {
        item_name: [{ value: cocinaTitles[c], marketplace_id: mpInfo.id, language_tag: loc }],
        brand: [{ value: "ROCKING GIFTS", marketplace_id: mpInfo.id }],
        manufacturer: [{ value: "ROCKING GIFTS", marketplace_id: mpInfo.id }],
        part_number: [{ value: "BUNDLE-COCINA-SAL-AZUC", marketplace_id: mpInfo.id }],
        model_number: [{ value: "BUNDLE-COCINA-SAL-AZUC", marketplace_id: mpInfo.id }],
        number_of_items: [{ value: 2, marketplace_id: mpInfo.id }],
        size: [{ value: "10cm + 9x8cm", marketplace_id: mpInfo.id, language_tag: loc }],
        color: [{ value: cocinaColors[c], marketplace_id: mpInfo.id, language_tag: loc }],
        included_components: cocinaComponents[c].map(comp => ({ value: comp, marketplace_id: mpInfo.id, language_tag: loc })),
        is_assembly_required: [{ value: false, marketplace_id: mpInfo.id }],
        is_fragile: [{ value: false, marketplace_id: mpInfo.id }],
        bullet_point: cocinaBullets[c].map(b => ({ value: b, marketplace_id: mpInfo.id, language_tag: loc })),
        product_description: [{ value: cocinaTitles[c], marketplace_id: mpInfo.id, language_tag: loc }],
        item_package_weight: [{ value: 0.45, unit: "kilograms", marketplace_id: mpInfo.id }],
        main_product_image_locator: [{ media_location: "https://m.media-amazon.com/images/I/31pU7T8ZYyL.jpg", marketplace_id: mpInfo.id }],
        other_product_image_locator_1: [{ media_location: "https://m.media-amazon.com/images/I/71a74miOlHL.jpg", marketplace_id: mpInfo.id }],
        condition_type: [{ value: "new_new", marketplace_id: mpInfo.id }],
        supplier_declared_dg_hz_regulation: [{ value: "not_applicable", marketplace_id: mpInfo.id }],
        country_of_origin: [{ value: "ES", marketplace_id: mpInfo.id }],
        fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 85, lead_time_to_ship_max_days: 2, marketplace_id: mpInfo.id }],
        purchasable_offer: [{
          currency: "EUR", marketplace_id: mpInfo.id, audience: "ALL",
          our_price: [{ schedule: [{ value_with_tax: 22.95 }] }],
          minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 11.48 }] }],
          maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: 45.90 }] }],
        }],
        list_price: [{ currency: "EUR", value_with_tax: 26.90, marketplace_id: mpInfo.id }],
        merchant_suggested_asin: [{ value: "B07TFBGPRT", marketplace_id: mpInfo.id }]
      }
    };

    const res = await client.request({
      method: "PUT",
      path: `/listings/2021-08-01/items/${env.sellerId}/BUNDLE-COCINA-SAL-AZUC?marketplaceIds=${mpInfo.id}&issueLocale=es_ES`,
      body: payload,
      rateLimitKey: "listingsItems.putListingsItem",
    });
    console.log(`[${c}] BUNDLE-COCINA-SAL-AZUC: ${res.status || "ACCEPTED"} (Submission: ${res.submissionId})`);
    if (res.issues?.length) console.log("   Issues:", JSON.stringify(res.issues));
  }

  // 2. BUNDLE-NAUTICO-FARO-SET
  console.log("\n========================================================");
  console.log("PUBLICANDO: BUNDLE-NAUTICO-FARO-SET en ES, DE, FR, IT, NL");
  console.log("========================================================");

  const faroTitles: Record<string, string> = {
    ES: "ROCKING GIFTS Conjunto Náutico Decorativo: Faro Marino Madera Blanco/Azul 28cm + Juego de 9 Posavasos Peces Vintage",
    DE: "ROCKING GIFTS Maritimes Deko-Set: Weiß/Blauer Holz-Leuchtturm 28cm + 9er Set Vintage Fisch-Untersetzer",
    FR: "ROCKING GIFTS Ensemble Décoration Marine : Phare Marin en Bois Blanc/Bleu 28cm + Lot de 9 Sous-Verres Poissons Vintage",
    IT: "ROCKING GIFTS Set Nautico Decorativo: Faro Marino in Legno Bianco/Blu 28cm + Set di 9 Sottobicchieri Pesci Vintage",
    NL: "ROCKING GIFTS Maritieme Decoratieset: Houten Vuurtoren Wit/Blauw 28cm + 9-delige Set Vintage Visonderzetters",
  };

  const faroBullets: Record<string, string[]> = {
    ES: [
      "AMBIENTE COSTERO Y MARINERO: Precioso set náutico con faro artesanal de madera y 9 posavasos con motivos marinos.",
      "MATERIALES NOBLES: Madera tallada y pintada a mano en tonalidades azul marino, turquesa y blanco envejecido.",
      "PROTECCIÓN Y ESTILO: Los 9 posavasos protegen tus mesas mientras aportan frescura veraniega y elegancia costera.",
      "REGALO IDEAL: Perfecto para decorar apartamentos de playa, terrazas, salones de estilo mediterráneo o casas de campo."
    ],
    DE: [
      "MARITIMES FLAIR: Schönes maritimes Deko-Set mit handgefertigtem Holz-Leuchtturm und 9 Vintage-Untersetzern.",
      "NATÜRLICHE MATERIALIEN: Massives Holz mit liebevoller Handbemalung in Weiß, Marineblau und Türkis.",
      "SCHUTZ & DEKORATION: Schützt empfindliche Tischoberflächen und setzt stimmungsvolle Urlaubs-Akzente.",
      "PERFEKTES GESCHENK: Tolle Geschenkidee für Küstenliebhaber, Ferienwohnungen und mediterranes Wohnambiente."
    ],
    FR: [
      "AMBIANCE BORD DE MER : Superbe ensemble marin comprenant un phare en bois artisanal et 9 sous-verres thématiques.",
      "MATÉRIAUX NOBLES : Bois sculpté et peint à la main dans des teintes chaleureuses de bleu marine et blanc cérusé.",
      "PROTECTION ET ÉLÉGANCE : Protège vos tables tout en créant une belle table d inspiration côtière.",
      "CADEAU UNIQUE : Idéal pour maisons de vacances, salons de style bord de mer ou terrasses estivales."
    ],
    IT: [
      "ATMOSFERA COSTIERA: Bellissimo set a tema mare con faro in legno artigianale e 9 sottobicchieri decorati a pesce.",
      "MATERIALI AUTENTICI: Legno naturale dipinto a mano nei classici toni del blu mare e bianco anticato.",
      "PROTEZIONE E FASCINO: Salvaguarda mobili e tavoli portando un tocco fresco e marinaro in ogni stanza.",
      "REGALO PERFETTO: Ideale per case al mare, taverne, terrazze o per chi ama lo stile marittimo mediterraneo."
    ],
    NL: [
      "MARITIEME SFEER: Prachtige kustdecoratieset met handgemaakte houten vuurtoren en 9 visonderzetters.",
      "NATUURLIJKE MATERIALEN: Handgeschilderd hout in stijlvolle wit- en blauwtinten met vintage finish.",
      "BESCHERMING EN STIJL: Beschermt tafels tegen kringen en brengt direct een zomerse vakantiesfeer.",
      "IDEAAL CADEAU: Prachtige toevoeging voor strandhuizen, veranda s of liefhebbers van de zee."
    ]
  };

  const faroColors: Record<string, string> = {
    ES: "Azul / Blanco",
    DE: "Blau / Weiß",
    FR: "Bleu / Blanc",
    IT: "Blu / Bianco",
    NL: "Blauw / Wit",
  };

  for (const c of countries) {
    const mpInfo = EU_MARKETPLACES[c];
    const loc = LOCALES[c];
    const payload = {
      productType: "SCULPTURE",
      requirements: "LISTING",
      attributes: {
        item_name: [{ value: faroTitles[c], marketplace_id: mpInfo.id, language_tag: loc }],
        brand: [{ value: "ROCKING GIFTS", marketplace_id: mpInfo.id }],
        manufacturer: [{ value: "ROCKING GIFTS", marketplace_id: mpInfo.id }],
        part_number: [{ value: "BUNDLE-NAUTICO-FARO", marketplace_id: mpInfo.id }],
        model_number: [{ value: "BUNDLE-NAUTICO-FARO", marketplace_id: mpInfo.id }],
        number_of_items: [{ value: 10, marketplace_id: mpInfo.id }],
        size: [{ value: "28cm + 9cm", marketplace_id: mpInfo.id, language_tag: loc }],
        color: [{ value: faroColors[c], marketplace_id: mpInfo.id, language_tag: loc }],
        power_plug_type: [{ value: "no_plug", marketplace_id: mpInfo.id }],
        item_depth_width_height: [{
          depth: { value: 10, unit: "centimeters" },
          width: { value: 10, unit: "centimeters" },
          height: { value: 28, unit: "centimeters" },
          marketplace_id: mpInfo.id
        }],
        bullet_point: faroBullets[c].map(b => ({ value: b, marketplace_id: mpInfo.id, language_tag: loc })),
        product_description: [{ value: faroTitles[c], marketplace_id: mpInfo.id, language_tag: loc }],
        item_package_weight: [{ value: 0.95, unit: "kilograms", marketplace_id: mpInfo.id }],
        main_product_image_locator: [{ media_location: "https://m.media-amazon.com/images/I/71p0WfA7WnL.jpg", marketplace_id: mpInfo.id }],
        other_product_image_locator_1: [{ media_location: "https://m.media-amazon.com/images/I/81xU-Uv0t8L.jpg", marketplace_id: mpInfo.id }],
        condition_type: [{ value: "new_new", marketplace_id: mpInfo.id }],
        supplier_declared_dg_hz_regulation: [{ value: "not_applicable", marketplace_id: mpInfo.id }],
        country_of_origin: [{ value: "ES", marketplace_id: mpInfo.id }],
        fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 235, lead_time_to_ship_max_days: 2, marketplace_id: mpInfo.id }],
        purchasable_offer: [{
          currency: "EUR", marketplace_id: mpInfo.id, audience: "ALL",
          our_price: [{ schedule: [{ value_with_tax: 44.95 }] }],
          minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 22.48 }] }],
          maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: 89.90 }] }],
        }],
        list_price: [{ currency: "EUR", value_with_tax: 54.90, marketplace_id: mpInfo.id }],
        merchant_suggested_asin: [{ value: "B0HJP1PW3K", marketplace_id: mpInfo.id }]
      }
    };

    const res = await client.request({
      method: "PUT",
      path: `/listings/2021-08-01/items/${env.sellerId}/BUNDLE-NAUTICO-FARO-SET?marketplaceIds=${mpInfo.id}&issueLocale=es_ES`,
      body: payload,
      rateLimitKey: "listingsItems.putListingsItem",
    });
    console.log(`[${c}] BUNDLE-NAUTICO-FARO-SET: ${res.status || "ACCEPTED"} (Submission: ${res.submissionId})`);
    if (res.issues?.length) console.log("   Issues:", JSON.stringify(res.issues));
  }
}

publishAllMarketplaces().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
