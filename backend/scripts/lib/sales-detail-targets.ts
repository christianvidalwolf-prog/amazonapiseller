/** Monthly order payloads cover every day/week without duplicating orders per country. */
export function salesDetailTargets(now = new Date()): Array<[string, string]> {
  const year = now.getUTCFullYear();
  const targets: Array<[string, string]> = [];
  // Include December for the first ISO week of the year.
  for (let month = -1; month <= now.getUTCMonth(); month++) {
    const start = new Date(Date.UTC(year, month, 1));
    const end = new Date(Date.UTC(year, month + 1, 0));
    const firstDay = start.toISOString().slice(0, 10);
    const lastDay = end.toISOString().slice(0, 10);
    targets.push([
      `sales:details:${firstDay.slice(0, 7)}`,
      `/api/sales/details?start=${firstDay}&end=${lastDay}&channel=ALL`,
    ]);
  }
  return targets;
}
