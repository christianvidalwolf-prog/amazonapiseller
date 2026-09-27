import type {
  PeriodOrderDetail,
  PeriodProductDetail,
  PeriodReturnDetail,
  PeriodSalesDetailResult,
} from "@/components/sales/PeriodSalesDetail";

/** Keep the detail endpoint's item-price revenue convention when filtering saved orders and returns. */
export function filterSalesDetails(
  sourceOrders: PeriodOrderDetail[],
  start: string,
  end: string,
  channel: string,
  sourceReturns: PeriodReturnDetail[] = []
): PeriodSalesDetailResult {
  const startTs = Date.parse(start);
  const endTs = Date.parse(end);

  const orders = sourceOrders
    .filter((order) => {
      const timestamp = Date.parse(order.purchaseDate);
      return (
        timestamp >= startTs &&
        timestamp <= endTs &&
        order.orderStatus.toLowerCase() !== "cancelled" &&
        (channel === "ALL" || order.salesChannel === channel)
      );
    })
    .sort((a, b) => b.purchaseDate.localeCompare(a.purchaseDate));

  const returns = (sourceReturns || [])
    .filter((ret) => {
      const timestamp = Date.parse(ret.returnDate);
      return (
        timestamp >= startTs &&
        timestamp <= endTs &&
        (channel === "ALL" || !ret.salesChannel || ret.salesChannel === "Desconocido" || ret.salesChannel === channel)
      );
    })
    .sort((a, b) => b.returnDate.localeCompare(a.returnDate));

  const products = new Map<
    string,
    PeriodProductDetail & { orderIds: Set<string> }
  >();

  let totalRevenue = 0;
  let totalUnits = 0;

  for (const order of orders) {
    for (const item of order.items) {
      totalRevenue += item.itemPrice;
      totalUnits += item.quantity;
      const product = products.get(item.sku) ?? {
        sku: item.sku,
        asin: item.asin,
        name: item.name,
        units: 0,
        returnedUnits: 0,
        netUnits: 0,
        revenue: 0,
        returnedRevenue: 0,
        netRevenue: 0,
        returnRatePct: 0,
        avgPrice: 0,
        orderCount: 0,
        orderIds: new Set<string>(),
      };
      product.units += item.quantity;
      product.revenue += item.itemPrice;
      product.orderIds.add(order.orderId);
      products.set(item.sku, product);
    }
  }

  let returnedRevenue = 0;
  let returnedUnits = 0;

  for (const ret of returns) {
    const qty = ret.quantity || 1;
    const refund = ret.refundAmount || 0;
    returnedUnits += qty;
    returnedRevenue += refund;

    const product = products.get(ret.sku);
    if (product) {
      product.returnedUnits = (product.returnedUnits || 0) + qty;
      product.returnedRevenue = Number(((product.returnedRevenue || 0) + refund).toFixed(2));
    }
  }

  const round = (value: number) => Number(value.toFixed(2));
  const netRevenue = round(totalRevenue - returnedRevenue);
  const netUnits = totalUnits - returnedUnits;
  const returnRatePct = totalUnits > 0 ? Number(((returnedUnits / totalUnits) * 100).toFixed(1)) : null;

  return {
    start,
    end,
    channel,
    orders,
    returns,
    metrics: {
      totalRevenue: round(totalRevenue),
      returnedRevenue: round(returnedRevenue),
      netRevenue,
      totalUnits,
      returnedUnits,
      netUnits,
      totalOrders: orders.length,
      totalReturns: returns.length,
      avgOrderValue: orders.length ? round(totalRevenue / orders.length) : 0,
      returnRatePct,
    },
    products: [...products.values()]
      .map(({ orderIds, ...product }) => {
        const pReturnedUnits = product.returnedUnits || 0;
        const pReturnedRev = product.returnedRevenue || 0;
        const pNetUnits = product.units - pReturnedUnits;
        const pNetRev = round(product.revenue - pReturnedRev);
        const pReturnRatePct = product.units > 0 ? Number(((pReturnedUnits / product.units) * 100).toFixed(1)) : 0;

        return {
          ...product,
          returnedUnits: pReturnedUnits,
          returnedRevenue: pReturnedRev,
          netUnits: pNetUnits,
          netRevenue: pNetRev,
          returnRatePct: pReturnRatePct,
          revenue: round(product.revenue),
          avgPrice: product.units ? round(product.revenue / product.units) : 0,
          orderCount: orderIds.size,
        };
      })
      .sort((a, b) => b.revenue - a.revenue),
  };
}

