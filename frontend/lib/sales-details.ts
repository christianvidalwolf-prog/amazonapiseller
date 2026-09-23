import type { PeriodOrderDetail, PeriodProductDetail, PeriodSalesDetailResult } from "@/components/sales/PeriodSalesDetail";

/** Keep the detail endpoint's item-price revenue convention when filtering saved orders. */
export function filterSalesDetails(
  sourceOrders: PeriodOrderDetail[], start: string, end: string, channel: string
): PeriodSalesDetailResult {
  const orders = sourceOrders.filter((order) => {
    const timestamp = Date.parse(order.purchaseDate);
    return timestamp >= Date.parse(start) && timestamp <= Date.parse(end) &&
      order.orderStatus.toLowerCase() !== "cancelled" &&
      (channel === "ALL" || order.salesChannel === channel);
  }).sort((a, b) => b.purchaseDate.localeCompare(a.purchaseDate));
  const products = new Map<string, PeriodProductDetail & { orderIds: Set<string> }>();
  let totalRevenue = 0;
  let totalUnits = 0;
  for (const order of orders) {
    for (const item of order.items) {
      totalRevenue += item.itemPrice;
      totalUnits += item.quantity;
      const product = products.get(item.sku) ?? {
        sku: item.sku, asin: item.asin, name: item.name,
        units: 0, revenue: 0, avgPrice: 0, orderCount: 0, orderIds: new Set<string>(),
      };
      product.units += item.quantity;
      product.revenue += item.itemPrice;
      product.orderIds.add(order.orderId);
      products.set(item.sku, product);
    }
  }
  const round = (value: number) => Number(value.toFixed(2));
  return {
    start, end, channel, orders,
    metrics: {
      totalRevenue: round(totalRevenue), totalUnits, totalOrders: orders.length,
      avgOrderValue: orders.length ? round(totalRevenue / orders.length) : 0,
    },
    products: [...products.values()].map(({ orderIds, ...product }) => ({
      ...product,
      revenue: round(product.revenue),
      avgPrice: product.units ? round(product.revenue / product.units) : 0,
      orderCount: orderIds.size,
    })).sort((a, b) => b.revenue - a.revenue),
  };
}
