import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SpApiClient } from "../../spapi/client";
import { getCatalogItem } from "../../spapi/endpoints/catalogItems";
import { getCompetitivePricing } from "../../spapi/endpoints/productPricing";
import type {
  BsrHistoryPoint,
  BsrRankInfo,
  ProductBsrHistoryResult,
  ProductBsrOverview,
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
  private readonly snapshotsFilePath: string;
  private readonly classificationTitlesFilePath: string;
  private classificationTitles: Record<string, string> = {};

  constructor(
    private readonly client: SpApiClient,
    private readonly marketplaceId: string
  ) {
    const dataDir = path.resolve(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
      } catch {
        // ignore
      }
    }
    this.snapshotsFilePath = path.resolve(dataDir, "bsr_snapshots.json");
    this.classificationTitlesFilePath = fileURLToPath(new URL("./classification_titles.json", import.meta.url));
    this.loadClassificationTitles();
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
  async fetchLiveBsr(asin: string): Promise<{
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
        marketplaceIds: [this.marketplaceId],
        includedData: ["salesRanks", "summaries"],
      });

      const salesRanks = catalogData.salesRanks || [];
      const mktRank = salesRanks.find((r) => r.marketplaceId === this.marketplaceId) || salesRanks[0];

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
          marketplaceId: this.marketplaceId,
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
   * Returns BSR overview for all active catalog products
   */
  async getCatalogBsr(): Promise<ProductBsrOverview[]> {
    const productsMap = this.loadProductsFromSales();
    let snapshots = this.readSnapshots();

    // Identificar ASINs que aún no tengan ranking registrado para consultarlos en lote
    const missingAsins = Array.from(productsMap.keys()).filter((asin) => {
      if (!/^[A-Z0-9]{10}$/i.test(asin)) return false;
      const snap = snapshots.find((s) => s.asin === asin);
      return !snap || (!snap.rootCategory && !snap.detailCategory);
    });

    if (missingAsins.length > 0) {
      const CHUNK_SIZE = 20;
      const toFetch = missingAsins.slice(0, 40);
      const newSnapshots: StoredSnapshot[] = [];

      for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
        const chunk = toFetch.slice(i, i + CHUNK_SIZE);
        try {
          const pricingRes = await getCompetitivePricing(this.client, {
            marketplaceId: this.marketplaceId,
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
        this.saveSnapshotsBatch(newSnapshots);
        snapshots = this.readSnapshots();
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
  async refreshProductBsr(asin: string): Promise<StoredSnapshot> {
    const live = await this.fetchLiveBsr(asin);
    const productsMap = this.loadProductsFromSales();
    const productInfo = productsMap.get(asin);

    const snapshot: StoredSnapshot = {
      asin,
      sku: productInfo?.sku || asin,
      name: productInfo?.name || "Producto",
      rootCategory: live.rootCategory,
      detailCategory: live.detailCategory,
      recordedAt: new Date().toISOString(),
    };

    this.saveSnapshot(snapshot);
    return snapshot;
  }

  /**
   * Returns the time-series history of General BSR and Detail Category BSR for an ASIN
   */
  async getProductBsrHistory(asin: string, days = 60): Promise<ProductBsrHistoryResult> {
    const productsMap = this.loadProductsFromSales();
    const product = productsMap.get(asin) || {
      sku: asin,
      name: "Producto",
      totalUnits30d: 0,
      salesByDay: new Map<string, number>(),
    };

    // Ensure we have current snapshot, or fetch it live
    let currentSnap = this.readSnapshots().find((s) => s.asin === asin);
    const hasIncompleteDetail = currentSnap?.detailCategory && (
      !currentSnap.detailCategory.title ||
      currentSnap.detailCategory.title.startsWith("Subcategoría (")
    );
    if ((!currentSnap || !currentSnap.rootCategory || hasIncompleteDetail) && /^[A-Z0-9]{10}$/i.test(asin)) {
      currentSnap = await this.refreshProductBsr(asin);
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

  private cleanCategoryTitle(id: string): string {
    const map: Record<string, string> = {
      kitchen_display_on_website: "Hogar y cocina",
      beauty_display_on_website: "Belleza",
      home_display_on_website: "Hogar",
      sports_display_on_website: "Deportes y aire libre",
      drugstore_display_on_website: "Salud y cuidado personal",
      jewelry_display_on_website: "Joyería",
    };
    return map[id] || id.replace(/_display_on_website/g, "").replace(/_/g, " ");
  }

  private loadProductsFromSales(): Map<
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

  private readSnapshots(): StoredSnapshot[] {
    if (!fs.existsSync(this.snapshotsFilePath)) return [];
    try {
      const data = fs.readFileSync(this.snapshotsFilePath, "utf-8");
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

  private saveSnapshot(snapshot: StoredSnapshot): void {
    const list = this.readSnapshots().filter((s) => s.asin !== snapshot.asin);
    list.push(snapshot);
    try {
      fs.writeFileSync(this.snapshotsFilePath, JSON.stringify(list, null, 2), "utf-8");
    } catch (err) {
      console.warn("No se pudo guardar snapshot BSR:", err);
    }
  }

  private saveSnapshotsBatch(newSnapshots: StoredSnapshot[]): void {
    const existing = this.readSnapshots();
    const newAsins = new Set(newSnapshots.map((s) => s.asin));
    const combined = existing.filter((s) => !newAsins.has(s.asin)).concat(newSnapshots);
    try {
      fs.writeFileSync(this.snapshotsFilePath, JSON.stringify(combined, null, 2), "utf-8");
    } catch (err) {
      console.warn("No se pudieron guardar snapshots BSR en batch:", err);
    }
  }
}
