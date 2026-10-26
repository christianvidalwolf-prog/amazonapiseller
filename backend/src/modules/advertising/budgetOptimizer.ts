/**
 * Optimizador diario de presupuesto por país (spec advertising §14).
 *
 * El regulador mueve pujas; este módulo mueve DINERO ENTRE CAMPAÑAS: cada día redistribuye el
 * presupuesto activo de las campañas profit-first hacia las que mejor funcionan (ACoS ≤ 20 %),
 * sin subir nunca el total. Reglas por campaña (ventana del informe, por defecto 30 días):
 *
 *  - GANADORA: ACoS ≤ 20 % con ≥ 10 clics. Si además está limitada por presupuesto
 *    (gasto diario real ≥ 80 % de su presupuesto) puede recibir hasta +25 % al día.
 *  - PERDEDORA: ACoS > 30 % con ≥ 30 clics, o ≥ 2 € gastados sin ventas. Cede hasta −25 % (mínimo 1 €).
 *  - OCIOSA: gasta menos del 50 % de su presupuesto (no lo puede gastar) y no es ganadora.
 *    Cede hasta −25 %: dinero que de todos modos no se gasta.
 *  - Protegida: creada hace < 7 días (aprendizaje) o cuyo presupuesto tocó el optimizador hace < 7 días.
 *
 * El dinero liberado se reparte entre las ganadoras limitadas proporcionalmente a sus ventas.
 * Puro: listas de campaña y métricas entran, cambios de presupuesto salen. Nada habla con Amazon.
 */

export const WINNER_ACOS = 20;
export const LOSER_ACOS = 30;
export const LOSER_DEAD_SPEND = 2;
export const WINNER_MIN_CLICKS = 10;
export const LOSER_MIN_CLICKS = 30;
export const CONSTRAINED_RATIO = 0.8;
export const IDLE_RATIO = 0.5;
export const MAX_STEP = 0.25;
export const MIN_BUDGET = 1;
export const PROTECT_DAYS = 7;

export interface CampaignMetrics {
  campaignId: string;
  name: string;
  budget: number;
  /** Inicio de la campaña (ISO); protege las de < 7 días. */
  startDate: string;
  spend: number;
  sales: number;
  clicks: number;
  /** El optimizador ya tocó su presupuesto hace < 7 días: no tocar dos veces la misma variable. */
  recentlyOptimized?: boolean;
}

export interface BudgetChange {
  campaignId: string;
  name: string;
  oldBudget: number;
  newBudget: number;
  reason: string;
}

export interface OptimizerResult {
  totalBefore: number;
  totalAfter: number;
  changes: BudgetChange[];
  skipped: Array<{ campaignId: string; name: string; reason: string }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Días efectivos de la campaña dentro de la ventana (mínimo 1). */
function effectiveDays(startDate: string, now: Date): number {
  const start = Date.parse(startDate);
  if (!Number.isFinite(start)) return 30;
  return Math.min(30, Math.max(1, Math.ceil((now.getTime() - start) / 86_400_000)));
}

export function rebalanceBudgets(
  metrics: CampaignMetrics[],
  now: Date = new Date(),
  cap: number | null = null
): OptimizerResult {
  const enabled = metrics.filter((m) => m.budget > 0);
  const totalBefore = round2(enabled.reduce((a, m) => a + m.budget, 0));
  const limit = cap ?? totalBefore;

  const changes: BudgetChange[] = [];
  const skipped: OptimizerResult["skipped"] = [];
  let pot = 0;
  const grow: Array<{ m: CampaignMetrics; target: number; sales: number; days: number }> = [];

  for (const m of enabled) {
    const days = effectiveDays(m.startDate, now);
    if (m.recentlyOptimized) {
      skipped.push({ campaignId: m.campaignId, name: m.name, reason: "protegida (su presupuesto se ajustó hace < 7 días)" });
      continue;
    }
    if (days < PROTECT_DAYS) {
      skipped.push({ campaignId: m.campaignId, name: m.name, reason: `protegida (${days} días de aprendizaje)` });
      continue;
    }
    const dailyAvg = m.spend / days;
    const utilization = m.budget > 0 ? dailyAvg / m.budget : 0;
    const acos = m.sales > 0 ? (m.spend / m.sales) * 100 : null;
    const winner = acos !== null && acos <= WINNER_ACOS && m.clicks >= WINNER_MIN_CLICKS;
    const loser = (acos !== null && acos > LOSER_ACOS && m.clicks >= LOSER_MIN_CLICKS) || (m.sales === 0 && m.spend >= LOSER_DEAD_SPEND);

    if (winner && utilization >= CONSTRAINED_RATIO) {
      const target = round2(Math.min(limit, m.budget * (1 + MAX_STEP)));
      if (target > m.budget) grow.push({ m, target, sales: m.sales, days });
      else skipped.push({ campaignId: m.campaignId, name: m.name, reason: "ganadora limitada, sin margen del tope" });
      continue;
    }
    if (loser) {
      const target = round2(Math.max(MIN_BUDGET, m.budget * (1 - MAX_STEP)));
      if (target < m.budget) {
        pot += m.budget - target;
        changes.push({ campaignId: m.campaignId, name: m.name, oldBudget: m.budget, newBudget: target, reason: `perdedora: ${acos !== null ? `ACoS ${round2(acos)} % con ${m.clicks} clics` : `${m.spend.toFixed(2)} € sin ventas`}` });
      }
      continue;
    }
    if (!winner && utilization < IDLE_RATIO) {
      const target = round2(Math.max(MIN_BUDGET, m.budget * (1 - MAX_STEP)));
      if (target < m.budget) {
        pot += m.budget - target;
        changes.push({ campaignId: m.campaignId, name: m.name, oldBudget: m.budget, newBudget: target, reason: `ociosa: gasta ${round2(dailyAvg)} €/día de ${m.budget} € (${Math.round(utilization * 100)} %)` });
      }
      continue;
    }
    skipped.push({
      campaignId: m.campaignId,
      name: m.name,
      reason: winner
        ? `ganadora sin límite de presupuesto (usa ${Math.round(utilization * 100)} %); crecer es trabajo de pujas`
        : `estable (ACoS ${acos !== null ? `${round2(acos)} %` : "sin ventas aún"}, usa ${Math.round(utilization * 100)} % de su presupuesto)`,
    });
  }

  // El dinero liberado va a las ganadoras limitadas, proporcional a sus ventas, sin pasarse del tope.
  // Con el tope por debajo del total actual (solo recortes), no se redistribuye nada.
  const totalSales = grow.reduce((a, g) => a + g.sales, 0) || 1;
  let available = limit >= totalBefore ? pot + (limit - totalBefore) : 0;
  for (const g of [...grow].sort((a, b) => b.sales - a.sales)) {
    const headroom = round2(g.target - g.m.budget);
    const share = round2(Math.min(headroom, (g.sales / totalSales) * available));
    if (share > 0) {
      const utilization = Math.round((g.m.spend / g.m.budget / g.days) * 100);
      changes.push({ campaignId: g.m.campaignId, name: g.m.name, oldBudget: g.m.budget, newBudget: round2(g.m.budget + share), reason: `ganadora (ACoS ${round2((g.m.spend / g.m.sales) * 100)} %, ${g.m.clicks} clics) limitada por presupuesto (${utilization} % usado)` });
      available -= share;
    }
  }

  // Aplicar los recortes y subidas a los valores finales por campaña.
  const byId = new Map<string, number>();
  for (const m of enabled) byId.set(m.campaignId, m.budget);
  let totalAfter = totalBefore;
  for (const c of changes) {
    const before = byId.get(c.campaignId) ?? 0;
    totalAfter += c.newBudget - before;
    byId.set(c.campaignId, c.newBudget);
  }
  return { totalBefore, totalAfter: round2(totalAfter), changes, skipped };
}
