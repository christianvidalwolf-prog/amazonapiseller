import fs from "node:fs";
import path from "node:path";
import type { SpApiClient } from "../../spapi/client";
import { getCompetitivePricing, getItemOffers } from "../../spapi/endpoints/productPricing";
import { getInventorySummaries } from "../../spapi/endpoints/fbaInventory";
import { getCatalogItem } from "../../spapi/endpoints/catalogItems";

export interface PricingProductSummary {
  asin: string;
  sku: string;
  name: string;
  stock: number;
  hasBuyBox: boolean;
  buyBoxStatus: "WON" | "LOST" | "NONE";
  buyBoxPrice: number | null;
  currency: string;
  totalOffers: number;
  competingOffersCount: number;
  salesRank: number | null;
  salesCategory: string | null;
  subcategory: string | null;
}

export interface PricingDashboardSummary {
  totalAnalyzed: number;
  buyBoxWonCount: number;
  buyBoxLostCount: number;
  noBuyBoxCount: number;
  buyBoxWinRate: number;
  multiOfferCount: number;
  products: PricingProductSummary[];
  cachedAt: string;
}

export interface CompetitorOffer {
  sellerId: string | null;
  sellerUrl: string | null;
  isMyOffer: boolean;
  isBuyBoxWinner: boolean;
  isFulfilledByAmazon: boolean;
  listingPrice: number;
  shippingPrice: number;
  totalPrice: number;
  currency: string;
  feedbackCount: number;
  positiveFeedbackRating: number | null;
  shipsFromCountry: string | null;
  condition: string;
  priceDifference: number | null;
}

export interface ProductOffersDetail {
  asin: string;
  buyBoxPrice: number | null;
  currency: string;
  totalOffersCount: number;
  offers: CompetitorOffer[];
}

export class PricingService {
  private cache: PricingDashboardSummary | null = null;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos
  private readonly categoryCache = new Map<string, { root: string | null; subcategory: string | null }>();

  constructor(private readonly client: SpApiClient, private readonly marketplaceId: string, private readonly sellerId?: string) {}

  /**
   * Obtiene el resumen de Buy Box y precios competitivos de los productos activos.
   */
  async getCompetitivePricingSummary(limit = 40, force = false): Promise<PricingDashboardSummary> {
    const now = Date.now();
    if (!force && this.cache && this.cache.totalAnalyzed === limit && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return this.cache;
    }

    // 1. Cargar productos activos con stock o de inventario
    const productsMap = await this.loadActiveProducts(limit);
    const asins = Object.keys(productsMap);

    if (asins.length === 0) {
      return {
        totalAnalyzed: 0,
        buyBoxWonCount: 0,
        buyBoxLostCount: 0,
        noBuyBoxCount: 0,
        buyBoxWinRate: 0,
        multiOfferCount: 0,
        products: [],
        cachedAt: new Date().toISOString(),
      };
    }

    // 2. Fragmentar en lotes de 20 ASINs (límite de la API de Amazon)
    const chunkSize = 20;
    const chunks: string[][] = [];
    for (let i = 0; i < asins.length; i += chunkSize) {
      chunks.push(asins.slice(i, i + chunkSize));
    }

    const analyzedProducts: PricingProductSummary[] = [];

    for (const chunk of chunks) {
      try {
        const response = await getCompetitivePricing(this.client, {
          marketplaceId: this.marketplaceId,
          asins: chunk,
        });

        const items = (response.payload as Array<Record<string, unknown>>) || [];
        for (const item of items) {
          const asin = String(item.ASIN || "");
          const meta = productsMap[asin] || { sku: asin, name: "Producto", stock: 0 };
          const prodObj = (item.Product as Record<string, unknown>) || {};
          const compPricing = (prodObj.CompetitivePricing as Record<string, unknown>) || {};
          const compPrices = (compPricing.CompetitivePrices as Array<Record<string, unknown>>) || [];
          const numOffersList = (compPricing.NumberOfOfferListings as Array<Record<string, unknown>>) || [];
          const salesRankings = (prodObj.SalesRankings as Array<Record<string, unknown>>) || [];

          // Calcular ofertas totales
          let totalOffers = 0;
          for (const no of numOffersList) {
            if (["any", "new"].includes(String(no.condition).toLowerCase())) {
              const c = Number(no.Count) || 0;
              if (c > totalOffers) totalOffers = c;
            }
          }

          // Analizar ganador de Buy Box
          let hasBuyBox = false;
          let buyBoxStatus: "WON" | "LOST" | "NONE" = "NONE";
          let buyBoxPrice: number | null = null;
          let currency = "EUR";

          if (compPrices.length > 0) {
            const firstComp = compPrices[0];
            const belongs = Boolean(firstComp.belongsToRequester);
            const priceObj = (firstComp.Price as Record<string, unknown>) || {};
            const landed = (priceObj.LandedPrice as Record<string, unknown>) || {};
            buyBoxPrice = Number(landed.Amount) || null;
            currency = String(landed.CurrencyCode || "EUR");

            if (belongs) {
              hasBuyBox = true;
              buyBoxStatus = "WON";
            } else {
              hasBuyBox = false;
              buyBoxStatus = "LOST";
            }
          } else {
            buyBoxStatus = "NONE";
          }

          // Extraer ranking de ventas (BSR)
          let salesRank: number | null = null;
          let salesCategory: string | null = null;
          if (salesRankings.length > 0) {
            salesRank = Number(salesRankings[0].Rank) || null;
            salesCategory = String(salesRankings[0].ProductCategoryId || "");
          }

          analyzedProducts.push({
            asin,
            sku: meta.sku,
            name: meta.name,
            stock: meta.stock,
            hasBuyBox,
            buyBoxStatus,
            buyBoxPrice,
            currency,
            totalOffers,
            competingOffersCount: Math.max(0, totalOffers - 1),
            salesRank,
            salesCategory,
            subcategory: null,
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`Error al consultar precios para chunk de ASINs:`, err);
      }
    }

    // Product Pricing only exposes category identifiers. Catalog Items adds
    // the human-readable root and detail-category titles.
    for (let i = 0; i < analyzedProducts.length; i += 5) {
      const batch = analyzedProducts.slice(i, i + 5);
      await Promise.all(batch.map(async (product) => {
        const cached = this.categoryCache.get(product.asin);
        if (cached) {
          product.salesCategory = cached.root || product.salesCategory;
          product.subcategory = cached.subcategory;
          return;
        }
        try {
          const catalog = await getCatalogItem(this.client, {
            asin: product.asin,
            marketplaceIds: [this.marketplaceId],
            includedData: ["salesRanks"],
          });
          const rankData = catalog.salesRanks?.find((r) => r.marketplaceId === this.marketplaceId) || catalog.salesRanks?.[0];
          const root = rankData?.displayGroupRanks?.[0]?.title || null;
          const subcategory = rankData?.classificationRanks?.[0]?.title || null;
          this.categoryCache.set(product.asin, { root, subcategory });
          product.salesCategory = root || product.salesCategory;
          product.subcategory = subcategory;
        } catch {
          this.categoryCache.set(product.asin, { root: null, subcategory: null });
        }
      }));
    }

    // Estadísticas
    const totalAnalyzed = analyzedProducts.length;
    const buyBoxWonCount = analyzedProducts.filter((p) => p.buyBoxStatus === "WON").length;
    const buyBoxLostCount = analyzedProducts.filter((p) => p.buyBoxStatus === "LOST").length;
    const noBuyBoxCount = analyzedProducts.filter((p) => p.buyBoxStatus === "NONE").length;
    const multiOfferCount = analyzedProducts.filter((p) => p.totalOffers > 1).length;
    const buyBoxWinRate = totalAnalyzed > 0 ? Math.round((buyBoxWonCount / totalAnalyzed) * 100) : 0;

    // Ordenar: primero los que tienen Buy Box perdida (riesgo), luego por stock
    analyzedProducts.sort((a, b) => {
      if (a.buyBoxStatus === "LOST" && b.buyBoxStatus !== "LOST") return -1;
      if (b.buyBoxStatus === "LOST" && a.buyBoxStatus !== "LOST") return 1;
      return b.stock - a.stock;
    });

    const summary: PricingDashboardSummary = {
      totalAnalyzed,
      buyBoxWonCount,
      buyBoxLostCount,
      noBuyBoxCount,
      buyBoxWinRate,
      multiOfferCount,
      products: analyzedProducts,
      cachedAt: new Date().toISOString(),
    };

    this.cache = summary;
    this.cacheTimestamp = now;

    return summary;
  }

  /**
   * Obtiene el desglose detallado de todos los competidores y ofertas para un ASIN específico.
   */
  async getProductOffersDetail(asin: string): Promise<ProductOffersDetail> {
    const raw = await getItemOffers(this.client, {
      marketplaceId: this.marketplaceId,
      asin,
      itemCondition: "New",
    });

    const payload = (raw.payload as Record<string, unknown>) || {};
    const summary = (payload.Summary as Record<string, unknown>) || {};
    const buyBoxPrices = (summary.BuyBoxPrices as Array<Record<string, unknown>>) || [];

    let buyBoxPrice: number | null = null;
    let currency = "EUR";
    if (buyBoxPrices.length > 0) {
      const landed = (buyBoxPrices[0].LandedPrice as Record<string, unknown>) || {};
      buyBoxPrice = Number(landed.Amount) || null;
      currency = String(landed.CurrencyCode || "EUR");
    }

    const rawOffers = (payload.Offers as Array<Record<string, unknown>>) || [];
    const offers: CompetitorOffer[] = [];

    for (const ro of rawOffers) {
      const isBuyBoxWinner = Boolean(ro.IsBuyBoxWinner);
      const isFulfilledByAmazon = Boolean(ro.IsFulfilledByAmazon);
      const listPriceObj = (ro.ListingPrice as Record<string, unknown>) || {};
      const shipPriceObj = (ro.Shipping as Record<string, unknown>) || {};
      const feedbackObj = (ro.SellerFeedbackRating as Record<string, unknown>) || {};
      const shipsFromObj = (ro.ShipsFrom as Record<string, unknown>) || {};

      const listingPrice = Number(listPriceObj.Amount) || 0;
      const shippingPrice = Number(shipPriceObj.Amount) || 0;
      const totalPrice = Number((listingPrice + shippingPrice).toFixed(2));
      const curr = String(listPriceObj.CurrencyCode || currency);

      const feedbackCount = Number(feedbackObj.FeedbackCount) || 0;
      const positiveFeedbackRating =
        feedbackObj.PositiveFeedbackRating !== undefined ? Number(feedbackObj.PositiveFeedbackRating) : null;
      const shipsFromCountry = shipsFromObj.Country ? String(shipsFromObj.Country) : null;
      const condition = String(ro.SubCondition || "New");

      const priceDifference = buyBoxPrice !== null ? Number((totalPrice - buyBoxPrice).toFixed(2)) : null;

      const sellerId = typeof ro.SellerId === "string" && ro.SellerId.trim() ? ro.SellerId.trim() : null;
      const domains: Record<string, string> = {
        A1RKKUPIHCS9HS: "www.amazon.es", A1PA6795UKMFR9: "www.amazon.de",
        A13V1IB3VIYZZH: "www.amazon.fr", APJ6JRA9NG5V4: "www.amazon.it",
        A1F83G8C2ARO7P: "www.amazon.co.uk", A1805IZSGTT6HS: "www.amazon.nl",
        ATVPDKIKX0DER: "www.amazon.com",
      };
      const domain = domains[this.marketplaceId];
      const sellerUrl = sellerId && domain
        ? `https://${domain}/sp?${new URLSearchParams({ seller: sellerId, marketplaceID: this.marketplaceId })}`
        : null;
      offers.push({
        sellerId,
        sellerUrl,
        isMyOffer: ro.MyOffer === true || Boolean(sellerId && this.sellerId && sellerId === this.sellerId),
        isBuyBoxWinner,
        isFulfilledByAmazon,
        listingPrice,
        shippingPrice,
        totalPrice,
        currency: curr,
        feedbackCount,
        positiveFeedbackRating,
        shipsFromCountry,
        condition,
        priceDifference,
      });
    }

    // Ordenar ofertas: primero la ganadora de la Buy Box, luego por precio total
    offers.sort((a, b) => {
      if (a.isBuyBoxWinner && !b.isBuyBoxWinner) return -1;
      if (!a.isBuyBoxWinner && b.isBuyBoxWinner) return 1;
      return a.totalPrice - b.totalPrice;
    });

    return {
      asin,
      buyBoxPrice,
      currency,
      totalOffersCount: offers.length,
      offers,
    };
  }

  private async loadActiveProducts(limit: number): Promise<Record<string, { sku: string; name: string; stock: number }>> {
    const map: Record<string, { sku: string; name: string; stock: number }> = {};

    // Prioridad 1: Productos con stock en inventario_fba_con_stock.csv
    const fbaStockPath = path.resolve(process.cwd(), "..", "inventario_fba_con_stock.csv");
    const altFbaStockPath = path.resolve(process.cwd(), "inventario_fba_con_stock.csv");
    const targetPath = [fbaStockPath, altFbaStockPath,
      path.resolve(process.cwd(), "..", "inventario_fba.csv"),
      path.resolve(process.cwd(), "inventario_fba.csv"),
    ].find((candidate) => fs.existsSync(candidate));

    if (targetPath) {
      try {
        const text = fs.readFileSync(targetPath, "utf-8");
        const lines = text.split(/\r?\n/).filter(Boolean);
        if (lines.length > 1) {
          const headers = lines[0].replace(/^\uFEFF/, "").split(";");
          const skuIdx = headers.indexOf("SKU");
          const asinIdx = headers.indexOf("ASIN");
          const nameIdx = headers.indexOf("Nombre");
          const totalIdx = headers.indexOf("Total");

          for (const line of lines.slice(1)) {
            const parts = line.split(";");
            const asin = parts[asinIdx];
            if (!asin || map[asin]) continue;

            map[asin] = {
              sku: parts[skuIdx] || asin,
              name: parts[nameIdx] || asin,
              stock: Number.parseInt(parts[totalIdx], 10) || 0,
            };

            if (limit > 0 && Object.keys(map).length >= limit) break;
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("No se pudo leer inventario_fba_con_stock.csv:", err);
      }
    }

    // En producción no dependemos de CSV locales: Render/Vercel no comparten
    // los archivos descargados en el ordenador del vendedor. La API devuelve
    // todas las páginas del inventario FBA.
    if (Object.keys(map).length < limit || Object.keys(map).length === 0) {
      try {
        let nextToken: string | undefined;
        do {
          const response = await getInventorySummaries(this.client, {
            marketplaceIds: [this.marketplaceId],
            nextToken,
          });
          for (const item of response.payload.inventorySummaries || []) {
            if (!item.asin || map[item.asin]) continue;
            map[item.asin] = {
              sku: item.sellerSku || item.asin,
              name: item.asin,
              stock: item.inventoryDetails?.fulfillableQuantity || 0,
            };
            if (limit > 0 && Object.keys(map).length >= limit) break;
          }
          nextToken = response.pagination?.nextToken;
        } while (nextToken && (limit <= 0 || Object.keys(map).length < limit));
      } catch (err) {
        console.warn("No se pudo cargar el catálogo completo desde FBA Inventory API:", err);
      }
    }

    return map;
  }
}
