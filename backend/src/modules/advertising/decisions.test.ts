import { describe, expect, it } from "vitest";
import { type CountryDaily, renderDailyReport } from "./dailyReport";
import { markProcessed, parseDecisions, proposalCode } from "./decisions";

describe("decisions file", () => {
  it("codes are short and stable per country and proposal", () => {
    const code = proposalCode("ES", "123|NEGATIVE_EXACT|piedras gratis");
    expect(code).toMatch(/^ES-[0-9a-f]{6}$/);
    expect(proposalCode("ES", "123|NEGATIVE_EXACT|piedras gratis")).toBe(code);
  });
  it("parses SI/NO (and synonyms), ignores comments and reports what it cannot read", () => {
    const { decisions, invalid } = parseDecisions("# comentario\nES-3f9a2c SI\nde-1B2C3D no\nFR-aaaaaa aprobar\nES-123 SI\nIT-bbbbbb quizás\n");
    expect(decisions).toEqual([
      { code: "ES-3f9a2c", verdict: "approved", line: 2 },
      { code: "DE-1b2c3d", verdict: "rejected", line: 3 },
      { code: "FR-aaaaaa", verdict: "approved", line: 4 },
    ]);
    expect(invalid.map((i) => i.line)).toEqual([5, 6]);
  });
  it("processed lines become dated comments so they never apply twice", () => {
    expect(markProcessed("ES-3f9a2c SI\nDE-1b2c3d NO", new Map([[1, "aplicada"]]), "2026-10-19")).toBe("# [2026-10-19 aplicada] ES-3f9a2c SI\nDE-1b2c3d NO");
  });
});

describe("renderDailyReport", () => {
  const country = (cc: string, acos: number | null): CountryDaily => ({
    country: cc,
    window: { start: "2026-10-19", end: "2026-11-17" },
    transition: false,
    all: { spend: 100, sales: acos ? 100 / (acos / 100) : 0, acos },
    pf: { spend: 100, sales: 400, acos: 25 },
    baselineAcos: 26.9,
    budget: 20,
    guard: { paused: [{ sku: "A1FBA", reason: "sin stock FBA" }], resumed: [] },
    regulator: { status: "ran", countryAcos: acos, mode: "down", changes: [{ label: "la keyword «mimbre»", oldBid: 0.3, newBid: 0.26, reason: "País 27 % > 22 %" }] },
    profit: { profitAfterAds: 42, leakSkus: 1, leakLoss: -5, winners: [{ sku: "W1", profit: 30 }], leaks: [{ sku: "L1", profit: -5 }] },
    deadCampaigns: [],
    decisions: [],
    pending: [{ code: `${cc}-abc123`, action: "Negar la búsqueda", text: "piedras <gratis>", reason: "Stop-loss" }],
    errors: [],
  });
  it("renders status, actions with reasons, approvals with instructions, escaping user text", () => {
    const html = renderDailyReport("2026-11-20", [country("ES", 27), country("IT", null)], [{ date: "2026-11-19", acos: { ES: 28, IT: null } }, { date: "2026-11-20", acos: { ES: 27, IT: null } }], "informes-ads/decisiones.txt", []);
    expect(html).toContain("Por encima del 25 %");
    expect(html).toContain("Sin datos aún");
    expect(html).toContain("0,30 € → <b>0,26 €</b>");
    expect(html).toContain("ES-abc123 SI");
    expect(html).toContain("piedras &lt;gratis&gt;");
    expect(html).toContain("Límite 25 %");
  });
});
