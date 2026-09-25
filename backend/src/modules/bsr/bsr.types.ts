export interface BsrRankInfo {
  id?: string;
  title: string;
  rank: number;
  link?: string;
}

export interface ProductBsrOverview {
  asin: string;
  sku: string;
  name: string;
  rootCategory?: BsrRankInfo | null;
  detailCategory?: BsrRankInfo | null;
  lastUpdated: string;
  totalSales30d?: number;
}

export interface BsrHistoryPoint {
  date: string; // YYYY-MM-DD
  rootRank: number | null;
  detailRank: number | null;
  unitsSold: number;
  rootCategoryTitle?: string;
  detailCategoryTitle?: string;
}

export interface ProductBsrHistoryResult {
  asin: string;
  sku: string;
  name: string;
  current: {
    rootCategory?: BsrRankInfo | null;
    detailCategory?: BsrRankInfo | null;
    lastUpdated: string;
  };
  history: BsrHistoryPoint[];
  stats: {
    bestRootRank: number | null;
    worstRootRank: number | null;
    bestDetailRank: number | null;
    worstDetailRank: number | null;
    currentRootRank: number | null;
    currentDetailRank: number | null;
  };
}

export interface BsrWeeklyCell {
  week: number;
  unitsSold: number;
  averageRootRank: number | null;
  averageDetailRank: number | null;
}

export interface BsrWeeklyProduct {
  asin: string;
  sku: string;
  name: string;
  totalUnits: number;
  weeks: BsrWeeklyCell[];
}

export interface BsrWeeklyOverview {
  periodStart: string;
  periodEnd: string;
  products: BsrWeeklyProduct[];
}
