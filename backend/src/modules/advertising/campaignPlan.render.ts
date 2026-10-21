import type { CampaignPlan } from "./campaignPlan";

/** Markdown of a campaign plan for human review before anything is created in Amazon. */
export function renderCampaignPlan(plan: CampaignPlan): string {
  const eur = (n: number) => `${n.toFixed(2)} €`;
  const groups = plan.campaigns.flatMap((c) => c.adGroups);
  const skus = new Set(groups.flatMap((g) => g.skus));
  const out = [
    `## ${plan.country} · presupuesto diario ${eur(plan.dailyBudget)}`,
    `${plan.campaigns.length} campañas · ${groups.length} grupos · ${skus.size} productos · ${groups.reduce((a, g) => a + g.keywords.length, 0)} keywords · ${groups.reduce((a, g) => a + g.targets.length, 0)} objetivos ASIN`,
    "| Campaña | Tipo | Presupuesto/día | Grupos (puja · productos) | Negativas |",
    "| --- | --- | --- | --- | --- |",
    ...plan.campaigns.map((c) => {
      const gs = c.adGroups
        .map((g) => {
          const auto = g.autoBids ? ` [cercana ${g.autoBids.close}, amplia ${g.autoBids.loose || "pausa"}, sustitutos ${g.autoBids.substitutes}, complementos ${g.autoBids.complements || "pausa"}]` : "";
          return `${g.name} · ${eur(g.defaultBid)} · ${g.skus.length} SKU${auto}`;
        })
        .join("<br>");
      return `| ${c.name} | ${c.targetingType} | ${eur(c.dailyBudget)} | ${gs} | ${c.negativeKeywords.length + c.negativeAsins.length} |`;
    }),
  ];
  const reasons = new Map<string, number>();
  for (const e of plan.excluded) {
    const key = e.reason.replace(/[\d.,]+ €/g, "X €");
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  out.push(`**Excluidos (${plan.excluded.length}):** ${[...reasons].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} (${n})`).join(" · ") || "ninguno"}`);
  out.push(`**Campañas antiguas a pausar al activar (${plan.pauseOld.length}):** ${plan.pauseOld.map((c) => c.name).join(" · ") || "ninguna"}`);
  out.push(...plan.assumptions.map((a) => `- ${a}`));
  return out.join("\n\n");
}
