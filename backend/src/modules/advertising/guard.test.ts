import { describe, expect, it } from "vitest";
import { guardAds } from "./guard";
import { regulate } from "./regulator";

describe("guardAds", () => {
  it("pauses unavailable ads and only re-enables the ones it paused itself", () => {
    const availability = new Map([
      ["A", { available: false, reason: "sin stock FBA" }],
      ["B", { available: true }],
      ["C", { available: true }],
    ]);
    const res = guardAds(
      [
        { adId: "1", sku: "A", state: "ENABLED" },
        { adId: "2", sku: "B", state: "PAUSED" }, // paused by the guard earlier → resume
        { adId: "3", sku: "C", state: "PAUSED" }, // paused by someone else → untouched
      ],
      availability,
      { paused: { "2": { sku: "B", reason: "sin Buy Box", date: "2026-10-18" } } },
      "2026-10-19"
    );
    expect(res.pause).toEqual([{ adId: "1", sku: "A", reason: "sin stock FBA" }]);
    expect(res.resume).toEqual([{ adId: "2", sku: "B" }]);
    expect(res.next.paused).toEqual({ "1": { sku: "A", reason: "sin stock FBA", date: "2026-10-19" } });
  });
});

describe("regulate", () => {
  const e = (id: string, bid: number, spend: number, sales: number, orders = 1) => ({ id, kind: "keyword" as const, label: id, bid, spend, sales, orders, clicks: 50 });

  it("above 22 % cuts entities above target by at most 15 %, leaving maturing ones alone", () => {
    const res = regulate([e("bad", 0.4, 30, 60), e("good", 0.3, 5, 100), e("dead", 0.2, 3, 0, 0), e("young", 0.5, 20, 30)], new Set(["young"]));
    expect(res.countryAcos).toBe(30.53); // 58 € / 190 €; factor = max(0.85, 22 / 30.53) = 0.85
    expect(res.mode).toBe("down");
    expect(res.changes.map((c) => [c.id, c.oldBid, c.newBid])).toEqual([
      ["bad", 0.4, 0.34],
      ["dead", 0.2, 0.17],
    ]);
  });

  it("below 18 % raises proven winners by 20 % (cap 1,50 €); between 18 and 22 % holds", () => {
    expect(regulate([e("win", 0.5, 10, 100, 3), e("one", 0.5, 2, 30, 1)]).changes).toEqual([
      expect.objectContaining({ id: "win", oldBid: 0.5, newBid: 0.6 }),
    ]);
    expect(regulate([e("x", 0.5, 20, 100, 3)]).mode).toBe("hold");
    expect(regulate([e("x", 0.5, 20, 0, 0)]).mode).toBe("no_data");
  });
});
