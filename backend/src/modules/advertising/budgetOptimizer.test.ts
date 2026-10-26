import { describe, expect, it } from "vitest";
import { rebalanceBudgets, type CampaignMetrics } from "./budgetOptimizer";

const NOW = new Date("2026-10-26T09:30:00Z");
const m = (over: Partial<CampaignMetrics>): CampaignMetrics => ({
  campaignId: "c",
  name: "C",
  budget: 10,
  startDate: "2026-09-01T00:00:00Z",
  spend: 0,
  sales: 0,
  clicks: 0,
  ...over,
});

describe("rebalanceBudgets", () => {
  it("moves budget from a loser to a constrained winner", () => {
    const res = rebalanceBudgets(
      [
        m({ campaignId: "win", name: "Ganadora", budget: 4, spend: 96, sales: 600, clicks: 60 }), // ACoS 16 %, 4 €/día = 100 % usado
        m({ campaignId: "lose", name: "Perdedora", budget: 4, spend: 150, sales: 300, clicks: 90 }), // ACoS 50 %
      ],
      NOW
    );
    const win = res.changes.find((c) => c.campaignId === "win");
    const lose = res.changes.find((c) => c.campaignId === "lose");
    expect(lose?.newBudget).toBe(3); // −25 %
    expect(win?.newBudget).toBe(5); // +25 % financiado por la perdedora
    expect(res.totalAfter).toBeLessThanOrEqual(res.totalBefore);
  });

  it("cuts idle campaigns that cannot spend their budget", () => {
    // ACoS 75 % (no ganadora), 12 clics (no perdedora por clics), gasta 12 % de su presupuesto.
    const res = rebalanceBudgets(
      [m({ campaignId: "idle", name: "Ociosa", budget: 4, spend: 15, sales: 20, clicks: 12 })],
      NOW
    );
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0].newBudget).toBe(3);
    expect(res.changes[0].reason).toContain("ociosa");
  });

  it("never inflates the total, even with several winners", () => {
    const res = rebalanceBudgets(
      [
        m({ campaignId: "w1", name: "W1", budget: 4, spend: 120, sales: 700, clicks: 70 }),
        m({ campaignId: "w2", name: "W2", budget: 4, spend: 96, sales: 500, clicks: 60 }),
      ],
      NOW
    );
    expect(res.totalAfter).toBeLessThanOrEqual(res.totalBefore);
    expect(res.changes.every((c) => c.newBudget <= c.oldBudget * 1.25 + 0.01)).toBe(true);
  });

  it("protects young campaigns (7 days of learning)", () => {
    const res = rebalanceBudgets(
      [m({ campaignId: "new", name: "Nueva", budget: 8, startDate: "2026-10-24T00:00:00Z", spend: 2, sales: 0, clicks: 20 })],
      NOW
    );
    expect(res.changes).toHaveLength(0);
    expect(res.skipped[0].reason).toContain("protegida");
  });

  it("marks a winner that is not budget-limited as stable", () => {
    const res = rebalanceBudgets(
      [m({ campaignId: "w", name: "W", budget: 10, spend: 60, sales: 400, clicks: 40 })], // ACoS 15 %, usa 20 %
      NOW
    );
    expect(res.changes).toHaveLength(0);
    expect(res.skipped[0].reason).toContain("crecer es trabajo de pujas");
  });

  it("respects the cap when provided", () => {
    const res = rebalanceBudgets(
      [
        m({ campaignId: "win", name: "W", budget: 4, spend: 120, sales: 700, clicks: 70 }),
        m({ campaignId: "lose", name: "L", budget: 4, spend: 150, sales: 300, clicks: 90 }),
      ],
      NOW,
      7 // tope total por debajo del actual: solo recortes, nada se redistribuye
    );
    expect(res.totalAfter).toBeLessThanOrEqual(7.01);
    expect(res.changes.find((c) => c.campaignId === "win")).toBeUndefined(); // la ganadora no crece
    expect(res.changes.find((c) => c.campaignId === "lose")?.newBudget).toBe(3);
  });
});
