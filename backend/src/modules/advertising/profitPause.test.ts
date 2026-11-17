import { describe, expect, it } from "vitest";
import { profitPause } from "./profitPause";

const ads = [
  { adId: "1", sku: "LOSER", state: "ENABLED" },
  { adId: "2", sku: "LOSER", state: "ENABLED" },
  { adId: "3", sku: "OK", state: "ENABLED" },
];
const profits = [
  { sku: "LOSER", spend: 70, adSales: 20, profitAfterAds: -61.75 },
  { sku: "OK", spend: 10, adSales: 60, profitAfterAds: 8 },
];

describe("product loss guard", () => {
  it("pauses every ad of a product losing ≥ 10 € with ACoS > 50 %, and not profitable ones", () => {
    const d = profitPause(ads, profits, {}, "2026-11-17");
    expect(d.pause.map((p) => p.adId)).toEqual(["1", "2"]);
    expect(d.next.LOSER.pausedAt).toBe("2026-11-17");
  });

  it("re-enables once after 30 days and pauses for good if it loses again", () => {
    const paused = ads.map((a) => (a.sku === "LOSER" ? { ...a, state: "PAUSED" } : a));
    const r1 = profitPause(paused, profits, { LOSER: { pausedAt: "2026-10-10", loss: -61 } }, "2026-11-10");
    expect(r1.resume.map((r) => r.adId)).toEqual(["1", "2"]);
    expect(profitPause(ads, profits, r1.next, "2026-11-15").pause).toEqual([]); // judged after 14 days
    const r2 = profitPause(ads, profits, r1.next, "2026-11-25");
    expect(r2.pause).toHaveLength(2);
    expect(r2.next.LOSER.permanent).toBe(true);
    expect(profitPause(paused, profits, r2.next, "2027-01-30").resume).toEqual([]);
  });

  it("leaves small spenders alone", () => {
    expect(profitPause(ads, [{ sku: "LOSER", spend: 5, adSales: 0, profitAfterAds: -12 }], {}, "2026-11-17").pause).toEqual([]);
  });
});
