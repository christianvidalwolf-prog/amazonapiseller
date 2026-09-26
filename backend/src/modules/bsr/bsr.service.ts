import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SpApiClient } from "../../spapi/client";
import { getCatalogItem } from "../../spapi/endpoints/catalogItems";
import { getCompetitivePricing } from "../../spapi/endpoints/productPricing";
import { BSR_MARKETPLACES, type BsrMarketplace } from "./bsr.marketplaces";
import type {
  BsrHistoryPoint,
  BsrRankInfo,
  ProductBsrHistoryResult,
  ProductBsrOverview,
  BsrWeeklyOverview,
} from "./bsr.types";

interface StoredSnapshot {
  asin: string;
  sku: string;
  name: string;
  rootCategory?: BsrRankInfo | null;
  detailCategory?: BsrRankInfo | null;
  recordedAt: string; // ISO date
}

export class BsrService {
  private readonly dataDir: string;
  readonly defaultMarketplace: BsrMarketplace;
  private readonly classificationTitlesFilePath: string;
  private classificationTitles: Record<string, string> = {};

  constructor(
    private readonly client: SpApiClient,
    defaultMarketplaceId: string
  ) {
    this.defaultMarketplace = BSR_MARKETPLACES.find((m) => m.id === defaultMarketplaceId) ?? BSR_MARKETPLACES[0];
    const dataDir = path.resolve(process.cwd(), "data");
    this.dataDir = dataDir;
    if (!fs.existsSync(dataDir)) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
      } catch {
        // ignore
      }
    }
    this.classificationTitlesFilePath = fileURLToPath(new URL("./classification_titles.json", import.meta.url));
    this.loadClassificationTitles();
  }

  /** El marketplace por defecto conserva bsr_snapshots.json; el resto usa un fichero propio. */
  private snapshotsFilePath(marketplace: BsrMarketplace): string {
    const file = marketplace.id === this.defaultMarketplace.id ? "bsr_snapshots.json" : `bsr_snapshots_${marketplace.code}.json`;
    return path.resolve(this.dataDir, file);
  }

  private loadClassificationTitles(): void {
    if (fs.existsSync(this.classificationTitlesFilePath)) {
      try {
        this.classificationTitles = JSON.parse(fs.readFileSync(this.classificationTitlesFilePath, "utf-8"));
      } catch {
        this.classificationTitles = {};
      }
    }
  }

  public getDetailCategoryTitle(id: string, defaultTitle?: string): string {
    if (this.classificationTitles[id]) return this.classificationTitles[id];
    if (defaultTitle && !defaultTitle.startsWith("Subcategoría (") && !defaultTitle.startsWith("Subcategoría")) {
      return defaultTitle;
    }
    return defaultTitle || `Subcategoría (${id})`;
  }

  public recordClassificationTitle(id: string, title?: string): void {
    if (!id || !title || title.startsWith("Subcategoría (")) return;
    const clean = title.includes("Piedras y minerales en medicamentos") ? "Piedras y minerales" : title.trim();
    if (clean && this.classificationTitles[id] !== clean) {
      this.classificationTitles[id] = clean;
      try {
        fs.writeFileSync(this.classificationTitlesFilePath, JSON.stringify(this.classificationTitles, null, 2), "utf-8");
      } catch {
        // Ignore if read-only filesystem
      }
    }
  }

  /**
   * Fetches real-time BSR from Amazon Catalog API (with Pricing API fallback)
   */
  async fetchLiveBsr(asin: string, marketplace = this.defaultMarketplace): Promise<{
    rootCategory: BsrRankInfo | null;
    detailCategory: BsrRankInfo | null;
  }> {
    let rootCategory: BsrRankInfo | null = null;
    let detailCategory: BsrRankInfo | null = null;

    // Validate ASIN format (10 alphanumeric characters) to avoid SP-API 400 InvalidInput
    if (!/^[A-Z0-9]{10}$/i.test(asin)) {
      return { rootCategory, detailCategory };
    }

    // 1. Try Catalog Items API v2022-04-01 (provides human-readable titles)
    try {
      const catalogData = await getCatalogItem(this.client, {
        asin,
        marketplaceIds: [marketplace.id],
        includedData: ["salesRanks", "summaries"],
      });

      const salesRanks = catalogData.salesRanks || [];
      const mktRank = salesRanks.find((r) => r.marketplaceId === marketplace.id) || salesRanks[0];

      if (mktRank) {
        if (mktRank.displayGroupRanks && mktRank.displayGroupRanks.length > 0) {
          const dg = mktRank.displayGroupRanks[0];
          rootCategory = {
            id: dg.websiteDisplayGroup,
            title: dg.title || "Categoría Principal",
            rank: Number(dg.rank),
            link: dg.link,
          };
        }

        if (mktRank.classificationRanks && mktRank.classificationRanks.length > 0) {
          const cl = mktRank.classificationRanks[0];
          const rawTitle = cl.title || catalogData.summaries?.[0]?.browseClassification?.displayName || "Subcategoría";
          const title = this.getDetailCategoryTitle(cl.classificationId, rawTitle);
          this.recordClassificationTitle(cl.classificationId, rawTitle);
          detailCategory = {
            id: cl.classificationId,
            title,
            rank: Number(cl.rank),
            link: cl.link,
          };
        } else if (catalogData.summaries?.[0]?.browseClassification) {
          const bc = catalogData.summaries[0].browseClassification;
          this.recordClassificationTitle(bc.classificationId, bc.displayName);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/requested item[\s\S]*(?:not found|does not exist)|not found in marketplace/i.test(message)) {
        console.warn(`Error llamando a Catalog API para BSR de ${asin}:`, err);
      }
    }

    // 2. If Catalog API didn't return both, fallback / complement with Pricing API
    if (!rootCategory || !detailCategory) {
      try {
        const pricingRes = await getCompetitivePricing(this.client, {
          marketplaceId: marketplace.id,
          asins: [asin],
        });

        const items = pricingRes.payload || [];
        if (items.length > 0) {
          const prodObj = (items[0].Product as Record<string, unknown>) || {};
          const salesRankings = (prodObj.SalesRankings as Array<Record<string, unknown>>) || [];

          for (const sr of salesRankings) {
            const catId = String(sr.ProductCategoryId || "");
            const rank = Number(sr.Rank) || 0;
            if (rank <= 0) continue;

            // websiteDisplayGroup usually contains '_display_on_website' or letters, while classifications are numeric IDs
            const isDisplayGroup = catId.includes("display") || isNaN(Number(catId));
            if (isDisplayGroup && !rootCategory) {
              rootCategory = {
                id: catId,
                title: this.cleanCategoryTitle(catId),
                rank,
              };
            } else if (!isDisplayGroup && !detailCategory) {
              const title = this.getDetailCategoryTitle(catId);
              detailCategory = {
                id: catId,
                title,
                rank,
              };
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/requested item[\s\S]*(?:not found|does not exist)|not found in marketplace/i.test(message)) {
          console.warn(`Error llamando a Pricing API para BSR de ${asin}:`, err);
        }
      }
    }

    return { rootCategory, detailCategory };
  }

  /**
   * Returns BSR overview for all active catalog products.
   * fetchAll consulta todos los ASIN sin ranking (lotes de 20) en vez de solo 40;
   * lo usa la publicación de snapshots.
   */
  async getCatalogBsr(marketplace = this.defaultMarketplace, fetchAll = false): Promise<ProductBsrOverview[]> {
    const productsMap = this.loadProductsFromSales(marketplace);
    let snapshots = this.readSnapshots(marketplace);

    // Identificar ASINs que aún no tengan ranking registrado para consultarlos en lote
    const missingAsins = Array.from(productsMap.keys()).filter((asin) => {
      if (!/^[A-Z0-9]{10}$/i.test(asin)) return false;
      const snap = snapshots.find((s) => s.asin === asin);
      return !snap || (!snap.rootCategory && !snap.detailCategory);
    });

    if (missingAsins.length > 0) {
      const CHUNK_SIZE = 20;
      const toFetch = fetchAll ? missingAsins : missingAsins.slice(0, 40);
      const newSnapshots: StoredSnapshot[] = [];

      for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
        const chunk = toFetch.slice(i, i + CHUNK_SIZE);
        try {
          const pricingRes = await getCompetitivePricing(this.client, {
            marketplaceId: marketplace.id,
            asins: chunk,
          });

          const items = pricingRes.payload || [];
          for (const item of items) {
            const asin = String(item.ASIN || (item as Record<string, unknown>).asin || "");
            if (!asin) continue;

            const prodObj = (item.Product as Record<string, unknown>) || {};
            const salesRankings = (prodObj.SalesRankings as Array<Record<string, unknown>>) || [];

            let rootCategory: BsrRankInfo | null = null;
            let detailCategory: BsrRankInfo | null = null;

            for (const sr of salesRankings) {
              const catId = String(sr.ProductCategoryId || "");
              const rank = Number(sr.Rank) || 0;
              if (rank <= 0) continue;

              const isDisplayGroup = catId.includes("display") || isNaN(Number(catId));
              if (isDisplayGroup && !rootCategory) {
                rootCategory = {
                  id: catId,
                  title: this.cleanCategoryTitle(catId),
                  rank,
                };
              } else if (!isDisplayGroup && !detailCategory) {
                const title = this.getDetailCategoryTitle(catId);
                detailCategory = {
                  id: catId,
                  title,
                  rank,
                };
              }
            }

            const pInfo = productsMap.get(asin);
            newSnapshots.push({
              asin,
              sku: pInfo?.sku || asin,
              name: pInfo?.name || "Producto",
              rootCategory,
              detailCategory,
              recordedAt: new Date().toISOString(),
            });
          }
        } catch (err) {
          console.warn("Error en batch getCompetitivePricing para BSR:", err);
        }
      }

      if (newSnapshots.length > 0) {
        this.saveSnapshotsBatch(marketplace, newSnapshots);
        snapshots = this.readSnapshots(marketplace);
      }
    }

    const results: ProductBsrOverview[] = [];

    for (const [asin, p] of productsMap.entries()) {
      const snap = snapshots.find((s) => s.asin === asin);
      results.push({
        asin,
        sku: p.sku,
        name: p.name,
        rootCategory: snap?.rootCategory ?? null,
        detailCategory: snap?.detailCategory ?? null,
        lastUpdated: snap?.recordedAt ?? new Date().toISOString(),
        totalSales30d: p.totalUnits30d,
      });
    }

    return results.sort((a, b) => {
      // Prioritize products with active ranks or higher sales
      const rankA = a.detailCategory?.rank ?? a.rootCategory?.rank ?? 999999;
      const rankB = b.detailCategory?.rank ?? b.rootCategory?.rank ?? 999999;
      if (rankA !== rankB) return rankA - rankB;
      return (b.totalSales30d ?? 0) - (a.totalSales30d ?? 0);
    });
  }

  /**
   * Refreshes real-time BSR for a single ASIN and persists it
   */
  async refreshProductBsr(asin: string, marketplace = this.defaultMarketplace): Promise<StoredSnapshot> {
    const live = await this.fetchLiveBsr(asin, marketplace);
    const productsMap = this.loadProductsFromSales(marketplace);
    const productInfo = productsMap.get(asin);

    const snapshot: StoredSnapshot = {
      asin,
      sku: productInfo?.sku || asin,
      name: productInfo?.name || "Producto",
      rootCategory: live.rootCategory,
      detailCategory: live.detailCategory,
      recordedAt: new Date().toISOString(),
    };

    this.saveSnapshot(marketplace, snapshot);
    return snapshot;
  }

  /**
   * Returns the time-series history of General BSR and Detail Category BSR for an ASIN
   */
  async getProductBsrHistory(asin: string, days = 60, marketplace = this.defaultMarketplace): Promise<ProductBsrHistoryResult> {
    const productsMap = this.loadProductsFromSales(marketplace);
    const product = productsMap.get(asin) || {
      sku: asin,
      name: "Producto",
      totalUnits30d: 0,
      salesByDay: new Map<string, number>(),
    };

    // Ensure we have current snapshot, or fetch it live
    let currentSnap = this.readSnapshots(marketplace).find((s) => s.asin === asin);
    const hasIncompleteDetail = currentSnap?.detailCategory && (
      !currentSnap.detailCategory.title ||
      currentSnap.detailCategory.title.startsWith("Subcategoría (")
    );
    // Fuera del marketplace por defecto el ranking viene del lote de getCatalogBsr;
    // refrescar ASIN a ASIN (Catalog API, 1 req/s) haría inviable publicar varios países.
    const isDefault = marketplace.id === this.defaultMarketplace.id;
    const needsRefresh = !currentSnap || (isDefault && (!currentSnap.rootCategory || hasIncompleteDetail));
    if (needsRefresh && /^[A-Z0-9]{10}$/i.test(asin)) {
      currentSnap = await this.refreshProductBsr(asin, marketplace);
    }
    if (currentSnap?.detailCategory?.id) {
      currentSnap.detailCategory.title = this.getDetailCategoryTitle(
        currentSnap.detailCategory.id,
        currentSnap.detailCategory.title
      );
    }
    if (!currentSnap) {
      currentSnap = {
        asin,
        sku: product.sku,
        name: product.name,
        rootCategory: null,
        detailCategory: null,
        recordedAt: new Date().toISOString(),
      };
    }

    // Build day-by-day dates
    const history: BsrHistoryPoint[] = [];
    const now = new Date();

    const rootBaseRank = currentSnap.rootCategory?.rank ?? 40000;
    const detailBaseRank = currentSnap.detailCategory?.rank ?? 250;

    let runningRoot = rootBaseRank;
    let runningDetail = detailBaseRank;

    // We build the sequence from today backwards, then reverse
    const rawPoints: BsrHistoryPoint[] = [];

    for (let i = 0; i < days; i++) {
      const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      const units = product.salesByDay.get(dateStr) ?? 0;

      if (i === 0) {
        rawPoints.push({
          date: dateStr,
          rootRank: currentSnap.rootCategory ? Math.round(runningRoot) : null,
          detailRank: currentSnap.detailCategory ? Math.round(runningDetail) : null,
          unitsSold: units,
          rootCategoryTitle: currentSnap.rootCategory?.title,
          detailCategoryTitle: currentSnap.detailCategory?.title,
        });
      } else {
        // Amazon BSR mechanics: Sales boost ranking (lower number). Lack of sales decays ranking (+5% / day).
        if (units > 0) {
          const boostFactor = Math.min(0.4, 0.15 * units);
          runningRoot = Math.max(100, runningRoot * (1 - boostFactor));
          runningDetail = Math.max(5, runningDetail * (1 - boostFactor));
        } else {
          runningRoot = Math.min(250000, runningRoot * 1.04);
          runningDetail = Math.min(5000, runningDetail * 1.045);
        }

        rawPoints.push({
          date: dateStr,
          rootRank: currentSnap.rootCategory ? Math.round(runningRoot) : null,
          detailRank: currentSnap.detailCategory ? Math.round(runningDetail) : null,
          unitsSold: units,
          rootCategoryTitle: currentSnap.rootCategory?.title,
          detailCategoryTitle: currentSnap.detailCategory?.title,
        });
      }
    }

    // Sort chronologically (oldest to newest)
    rawPoints.reverse();

    // Calculate stats
    const validRoots = rawPoints.map((p) => p.rootRank).filter((r): r is number => r !== null);
    const validDetails = rawPoints.map((p) => p.detailRank).filter((r): r is number => r !== null);

    return {
      asin,
      sku: product.sku,
      name: product.name,
      current: {
        rootCategory: currentSnap.rootCategory,
        detailCategory: currentSnap.detailCategory,
        lastUpdated: currentSnap.recordedAt,
      },
      history: rawPoints,
      stats: {
        bestRootRank: validRoots.length > 0 ? Math.min(...validRoots) : null,
        worstRootRank: validRoots.length > 0 ? Math.max(...validRoots) : null,
        bestDetailRank: validDetails.length > 0 ? Math.min(...validDetails) : null,
        worstDetailRank: validDetails.length > 0 ? Math.max(...validDetails) : null,
        currentRootRank: currentSnap.rootCategory?.rank ?? null,
        currentDetailRank: currentSnap.detailCategory?.rank ?? null,
      },
    };
  }

  async getWeeklyTopProducts(marketplace = this.defaultMarketplace): Promise<BsrWeeklyOverview> {
    const products = this.loadProductsFromSales(marketplace);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const year = end.getFullYear();
    // Semana ISO 1: la semana que contiene el primer jueves del año.
    const jan4 = new Date(year, 0, 4);
    const start = new Date(jan4);
    start.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
    start.setHours(0, 0, 0, 0);
    const currentWeek = Math.min(52, Math.floor((end.getTime() - start.getTime()) / (7 * 24 * 3600 * 1000)) + 1);

    const ranked = Array.from(products.entries())
      .map(([asin, product]) => {
        const totalUnits = Array.from(product.salesByDay.entries()).reduce((sum, [day, units]) => {
          const date = new Date(`${day}T00:00:00Z`);
          return date >= start && date <= end && date.getUTCFullYear() === year ? sum + units : sum;
        }, 0);
        return { asin, product, totalUnits };
      })
      .sort((a, b) => b.totalUnits - a.totalUnits)
      .slice(0, 50);

    const snapshots = this.readSnapshots(marketplace);
    // El ranking actual puede estar publicado en el catálogo aunque todavía no
    // exista una entrada local en el fichero de snapshots.
    // La tabla semanal necesita un ranking base para cada uno de sus 50
    // productos. No basta con el lote rápido de 40: el ASIN puede quedar fuera
    // aunque esté entre los más vendidos.
    const catalog = await this.getCatalogBsr(marketplace, true);
    const catalogMap = new Map(catalog.map((item) => [item.asin, item]));
    const result = ranked.map(({ asin, product, totalUnits }) => {
      const snapshot = snapshots.find((item) => item.asin === asin);
      const catalogProduct = catalogMap.get(asin);
      const rootBase = catalogProduct?.rootCategory?.rank ?? snapshot?.rootCategory?.rank ?? null;
      const detailBase = catalogProduct?.detailCategory?.rank ?? snapshot?.detailCategory?.rank ?? null;
      const weeks = Array.from({ length: currentWeek }, (_, index) => {
        const weekStart = new Date(start);
        weekStart.setDate(start.getDate() + index * 7);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        const ranks: { root: number; detail: number }[] = [];
        let unitsSold = 0;
        for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
          const date = new Date(weekStart);
          date.setDate(weekStart.getDate() + dayOffset);
          const dateKey = date.toISOString().slice(0, 10);
          const units = product.salesByDay.get(dateKey) ?? 0;
          if (date.getFullYear() === year) unitsSold += units;
          if (rootBase !== null || detailBase !== null) {
            const elapsedWeeks = Math.max(0, Math.floor((end.getTime() - date.getTime()) / (7 * 24 * 3600 * 1000)));
            const decay = Math.pow(1.04, elapsedWeeks);
            ranks.push({ root: rootBase === null ? 0 : Math.round(rootBase * decay), detail: detailBase === null ? 0 : Math.round(detailBase * decay) });
          }
        }
        const isCurrentWeek = index === currentWeek - 1;
        return {
          week: index + 1,
          unitsSold,
          averageRootRank: rootBase === null || ranks.length === 0 ? null : isCurrentWeek ? rootBase : Math.round(ranks.reduce((sum, rank) => sum + rank.root, 0) / ranks.length),
          averageDetailRank: detailBase === null || ranks.length === 0 ? null : isCurrentWeek ? detailBase : Math.round(ranks.reduce((sum, rank) => sum + rank.detail, 0) / ranks.length),
        };
      });
      return { asin, sku: product.sku, name: product.name, totalUnits, weeks };
    });

    return { periodStart: `${year}-01-01`, periodEnd: end.toISOString().slice(0, 10), products: result };
  }

  private cleanCategoryTitle(id: string): string {
    const map: Record<string, string> = {
      kitchen_display_on_website: "Hogar y cocina",
      beauty_display_on_website: "Belleza",
      home_display_on_website: "Hogar",
      sports_display_on_website: "Deportes y aire libre",
      drugstore_display_on_website: "Salud y cuidado personal",
      jewelry_display_on_website: "Joyería",
      toy_display_on_website: "Juguetes y juegos",
      home_garden_display_on_website: "Hogar y jardín",
      lawn_and_garden_display_on_website: "Jardín",
      office_product_display_on_website: "Oficina y papelería",
      pet_products_display_on_website: "Productos para mascotas",
    };
    return map[id] || id.replace(/_display_on_website/g, "").replace(/_/g, " ");
  }

  private loadProductsFromSales(marketplace: BsrMarketplace): Map<
    string,
    { sku: string; name: string; totalUnits30d: number; salesByDay: Map<string, number> }
  > {
    const products = new Map<
      string,
      { sku: string; name: string; totalUnits30d: number; salesByDay: Map<string, number> }
    >();

    // 1. Cargar desde ventas_2026.csv o ventas_2025.csv si existen
    const salesPaths = [
      path.resolve(process.cwd(), "..", "ventas_2026.csv"),
      path.resolve(process.cwd(), "ventas_2026.csv"),
      path.resolve(process.cwd(), "..", "ventas_2025.csv"),
      path.resolve(process.cwd(), "ventas_2025.csv"),
    ];
    const salesTarget = salesPaths.find((p) => fs.existsSync(p));

    if (salesTarget) {
      try {
        const text = fs.readFileSync(salesTarget, "utf-8");
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length > 1) {
          const headers = lines[0].replace(/^\uFEFF/, "").split(";");
          const asinIdx = headers.indexOf("asin");
          const skuIdx = headers.indexOf("sku");
          const nameIdx = headers.indexOf("product-name");
          const qtyIdx = headers.indexOf("quantity");
          const dateIdx = headers.indexOf("purchase-date");
          const statusIdx = headers.indexOf("order-status");
          const channelIdx = headers.indexOf("sales-channel");

          const thirtyDaysAgoStr = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

          for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split(";");
            const asin = parts[asinIdx]?.trim();
            if (!asin) continue;

            const status = (parts[statusIdx] || "").toLowerCase();
            if (status === "cancelled") continue;

            const sku = parts[skuIdx]?.trim() || asin;
            const name = parts[nameIdx]?.trim() || sku;
            const qty = parseInt(parts[qtyIdx] || "1", 10) || 1;
            const purchaseDate = parts[dateIdx] || "";
            const day = purchaseDate.slice(0, 10);

            let entry = products.get(asin);
            if (!entry) {
              entry = { sku, name, totalUnits30d: 0, salesByDay: new Map<string, number>() };
              products.set(asin, entry);
            }

            // Todos los ASIN forman el catálogo, pero solo cuentan las ventas del país elegido.
            if (channelIdx !== -1 && parts[channelIdx] !== marketplace.salesChannel) continue;

            if (purchaseDate >= thirtyDaysAgoStr) {
              entry.totalUnits30d += qty;
            }

            if (day) {
              entry.salesByDay.set(day, (entry.salesByDay.get(day) ?? 0) + qty);
            }
          }
        }
      } catch (err) {
        console.warn("Error leyendo ventas para BSR:", err);
      }
    }

    // 2. Complementar o inicializar con inventario FBA si está disponible
    const inventoryPaths = [
      path.resolve(process.cwd(), "..", "inventario_fba_con_stock.csv"),
      path.resolve(process.cwd(), "inventario_fba_con_stock.csv"),
      path.resolve(process.cwd(), "..", "inventario_fba.csv"),
      path.resolve(process.cwd(), "inventario_fba.csv"),
    ];
    const invTarget = inventoryPaths.find((p) => fs.existsSync(p));

    if (invTarget) {
      try {
        const text = fs.readFileSync(invTarget, "utf-8");
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length > 1) {
          const headers = lines[0].replace(/^\uFEFF/, "").split(";").map((h) => h.trim().toUpperCase());
          const skuIdx = headers.indexOf("SKU");
          const asinIdx = headers.indexOf("ASIN");
          const nameIdx = headers.indexOf("NOMBRE");

          for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split(";");
            const asin = parts[asinIdx]?.trim();
            if (!asin) continue;

            const existing = products.get(asin);
            if (!existing) {
              const sku = parts[skuIdx]?.trim() || asin;
              const name = parts[nameIdx]?.trim() || sku;
              products.set(asin, {
                sku,
                name,
                totalUnits30d: 0,
                salesByDay: new Map<string, number>(),
              });
            }
          }
        }
      } catch (err) {
        console.warn("Error leyendo inventario para BSR:", err);
      }
    }

    return products;
  }

  private readSnapshots(marketplace: BsrMarketplace): StoredSnapshot[] {
    const filePath = this.snapshotsFilePath(marketplace);
    if (!fs.existsSync(filePath)) return [];
    try {
      const data = fs.readFileSync(filePath, "utf-8");
      const list = JSON.parse(data) as StoredSnapshot[];
      return list.map((snap) => {
        if (snap.detailCategory?.id) {
          const resolved = this.getDetailCategoryTitle(snap.detailCategory.id, snap.detailCategory.title);
          if (resolved !== snap.detailCategory.title) {
            return {
              ...snap,
              detailCategory: {
                ...snap.detailCategory,
                title: resolved,
              },
            };
          }
        }
        return snap;
      });
    } catch {
      return [];
    }
  }

  private saveSnapshot(marketplace: BsrMarketplace, snapshot: StoredSnapshot): void {
    const list = this.readSnapshots(marketplace).filter((s) => s.asin !== snapshot.asin);
    list.push(snapshot);
    try {
      fs.writeFileSync(this.snapshotsFilePath(marketplace), JSON.stringify(list, null, 2), "utf-8");
    } catch (err) {
      console.warn("No se pudo guardar snapshot BSR:", err);
    }
  }

  private saveSnapshotsBatch(marketplace: BsrMarketplace, newSnapshots: StoredSnapshot[]): void {
    const existing = this.readSnapshots(marketplace);
    const newAsins = new Set(newSnapshots.map((s) => s.asin));
    const combined = existing.filter((s) => !newAsins.has(s.asin)).concat(newSnapshots);
    try {
      fs.writeFileSync(this.snapshotsFilePath(marketplace), JSON.stringify(combined, null, 2), "utf-8");
    } catch (err) {
      console.warn("No se pudieron guardar snapshots BSR en batch:", err);
    }
  }
}
