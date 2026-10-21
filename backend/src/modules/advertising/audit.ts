import type { AdCampaign, AdvertisingSummary } from "../../ads/types";
import type { AdvertisingProfitabilityResponse } from "./advertising.service";
import { addDays, REVIEW_AFTER_DAYS } from "./changelog";
import type { KeywordHarvestResponse } from "./negatives.service";

/**
 * Weekly audit in the 5 sections of the amazon-ads-spapi-optimizer skill (spec advertising §9):
 * health summary, critical alerts, ACoS cuts, growth actions and Change Log rows.
 * Proposals only: the Change Log rows are what to record once a person approves them.
 */

export interface CountryAuditInput {
  country: string;
  summary: AdvertisingSummary;
  campaigns: AdCampaign[];
  profitability: AdvertisingProfitabilityResponse;
  keywords: KeywordHarvestResponse;
}

const eur = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toFixed(2)} €`);
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toFixed(1)} %`);
const table = (head: string[], rows: string[][]) =>
  rows.length ? [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n") : "_Nada que señalar._";

interface ChangeRow {
  sku: string;
  entity: string;
  action: string;
  oldValue: string;
  newValue: string;
  baseline: string;
}

export function buildCountryAudit(input: CountryAuditInput, today: string): { markdown: string; changes: ChangeRow[] } {
  const { country, summary, campaigns, profitability: p, keywords: k } = input;
  const m = summary.metrics;
  const skus = p.skus ?? [];
  const changes: ChangeRow[] = [];
  const out: string[] = [`## ${country} · ventana ${summary.period.start} → ${summary.period.end}`];

  if (summary.dataStatus !== "ok" || !m) out.push(`> **No concluyente** (${summary.inconclusiveReason}): ${summary.message ?? summary.error?.message ?? ""}`);
  if (p.dataStatus !== "ok") out.push(`> Puente de rentabilidad **no concluyente** (${p.inconclusiveReason}): ${p.message ?? ""}`);

  out.push("### 1. Resumen ejecutivo de salud");
  if (m) {
    const organic = m.totalStoreSales ? Math.max(0, m.totalStoreSales - m.attributedSales) : null;
    out.push(
      table(
        ["Ventas totales", "Ventas PPC", "% orgánico", "Gasto PPC", "ACoS", "TACoS", "Beneficio tras Ads", "Cobertura costes"],
        [[
          eur(m.totalStoreSales),
          eur(m.attributedSales),
          organic !== null && m.totalStoreSales ? pct((organic / m.totalStoreSales) * 100) : "—",
          eur(m.spend),
          pct(m.acos),
          pct(m.tacos),
          eur(p.totals?.profitAfterAds),
          p.totals ? pct(p.totals.costCoverage * 100) : "—",
        ]]
      )
    );
  }
  const top = [...skus].sort((a, b) => b.spend - a.spend).slice(0, 15);
  out.push(
    table(
      ["SKU", "Gasto", "Ventas Ads", "ACoS", "Equilibrio", "Objetivo", "WOC", "Buy Box", "Tras Ads", "Veredicto"],
      top.map((s) => [s.sku, eur(s.spend), eur(s.adSales), pct(s.acos), pct(s.breakEvenAcos), pct(s.targetAcos), s.woc === null ? "—" : `${s.woc} sem`, s.buyBox === null ? "—" : s.buyBox ? "sí" : "**NO**", eur(s.profitAfterAds), s.verdict])
    )
  );

  out.push("### 2. Alertas críticas (circuit breakers)");
  const alerts = (p.alerts ?? []).map((a) => [a.sku, a.flags.join(", "), eur(a.spend), a.woc === null ? "—" : `${a.woc} sem`]);
  const dead = campaigns.filter((c) => c.state === "enabled" && c.metrics && c.metrics.impressions === 0);
  out.push(p.contextAvailable === false ? "_Sin contexto de stock/Buy Box: ejecutar `ADS_SYNC_STEPS=context npm run ads:sync-reports`._" : table(["SKU", "Alerta", "Gasto", "WOC"], alerts));
  if (dead.length) out.push(`**Campañas activas sin una sola impresión en la ventana (${dead.length}):** ${dead.map((c) => c.name).join(" · ")} → revisar elegibilidad (stock, Buy Box) y pujas.`);
  const overTarget = (summary.placements ?? []).filter((pl) => pl.acos !== null && m && pl.acos > m.acos * 1.5);
  if (overTarget.length) out.push(`**Ubicaciones con ACoS muy por encima de la media (${pct(m?.acos)}):** ${overTarget.map((pl) => `${pl.placement} ${pct(pl.acos)} (${eur(pl.spend)})`).join(" · ")}`);

  out.push("### 3. Acciones para bajar el ACoS (corte de fugas)");
  const negs = k.negatives?.proposals ?? [];
  out.push(
    table(
      ["Campaña", "Grupo", "Término", "Tipo", "Gasto", "Clics", "Motivo"],
      negs.map((n) => [n.campaignId, n.adGroupId, n.text, n.type, eur(n.spend), String(n.clicks), n.reason])
    )
  );
  if (k.negatives) out.push(`Fuga sin venta: ${eur(k.negatives.summary.zeroSaleSpend)} · recuperable con negativas: ${eur(k.negatives.summary.proposedSpend)} · dispersa: ${eur(k.negatives.summary.insufficientSpend + k.negatives.summary.noCostSpend)}.`);
  const cuts = skus.filter((s) => s.bidAction === "bajar" || s.bidAction === "pausar" || (s.verdict === "leak" && s.spend >= 5));
  out.push(
    table(
      ["SKU", "Acción", "CPC actual", "CPC sostenible", "ACoS", "Objetivo", "Tras Ads", "Motivo"],
      cuts.map((s) => [s.sku, s.bidAction === "pausar" || s.bidAction === "bajar" ? s.bidAction : "retirar del grupo", eur(s.cpc), eur(s.maxCpc), pct(s.acos), pct(s.targetAcos), eur(s.profitAfterAds), s.bidReason ?? "Fuga: gasto sin beneficio"])
    )
  );
  for (const s of cuts) {
    changes.push({ sku: s.sku, entity: "SKU (anuncio)", action: s.bidAction === "bajar" ? "Bajar CPC" : s.bidAction === "pausar" ? "Pausar anuncio" : "Retirar del grupo", oldValue: eur(s.cpc), newValue: s.bidAction === "bajar" ? eur(s.suggestedCpc) : "pausado", baseline: `gasto ${eur(s.spend)}, ACoS ${pct(s.acos)}, tras Ads ${eur(s.profitAfterAds)}` });
  }
  for (const n of negs) changes.push({ sku: "—", entity: `Grupo ${n.adGroupId}`, action: n.type, oldValue: "—", newValue: n.text, baseline: `${n.clicks} clics, ${eur(n.spend)}, 0 ventas` });

  out.push("### 4. Acciones para escalar ventas (crecimiento rentable)");
  const harvest = (k.harvest ?? []).filter((h) => h.rule === "harvest");
  out.push(
    table(
      ["Término", "Destino", "Pedidos", "ACoS", "Equilibrio", "Puja inicial", "Negativa en origen"],
      harvest.map((h) => [h.text, h.type === "HARVEST_EXACT" ? "Exacta" : "Producto (ASIN)", String(h.orders), pct(h.acos), pct(h.breakEvenAcos), eur(h.suggestedBid), `Grupo ${h.adGroupId}`])
    )
  );
  const raises = skus.filter((s) => s.bidAction === "subir" && s.verdict === "profitable");
  out.push(table(["SKU", "CPC actual", "CPC propuesto (máx. +20 %)", "Tras Ads"], raises.map((s) => [s.sku, eur(s.cpc), eur(s.suggestedCpc), eur(s.profitAfterAds)])));
  for (const h of harvest) changes.push({ sku: "—", entity: `Grupo ${h.adGroupId}`, action: `Graduar a ${h.type === "HARVEST_EXACT" ? "Exacta" : "producto"}`, oldValue: "descubrimiento", newValue: `${h.text} @ ${eur(h.suggestedBid)}`, baseline: `${h.orders} pedidos, ACoS ${pct(h.acos)}` });
  for (const s of raises) changes.push({ sku: s.sku, entity: "SKU (anuncio)", action: "Subir CPC", oldValue: eur(s.cpc), newValue: eur(s.suggestedCpc), baseline: `tras Ads ${eur(s.profitAfterAds)}` });

  out.push("### 5. Registro para el Change Log");
  const review = addDays(`${today}T00:00:00Z`, REVIEW_AFTER_DAYS);
  out.push(table(["Fecha", "SKU", "Entidad", "Acción propuesta", "Valor anterior", "Valor nuevo", "Métrica baseline", "Próxima revisión"], changes.map((c) => [today, c.sku, c.entity, c.action, c.oldValue, c.newValue, c.baseline, review])));
  return { markdown: out.join("\n\n"), changes };
}
