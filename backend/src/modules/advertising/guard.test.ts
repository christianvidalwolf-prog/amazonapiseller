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

  it("cuts each entity on its own ACoS (max −30 %), dead spend by clicks/€, leaving cooling ones alone", () => {
    const res = regulate([e("bad", 0.4, 30, 60), e("good", 0.3, 5, 100), e("dead", 0.2, 3, 0, 0), e("young", 0.5, 20, 30)], new Set(["young"]));
    expect(res.countryAcos).toBe(30.53);
    expect(res.mode).toBe("down");
    expect(res.changes.map((c) => [c.id, c.oldBid, c.newBid])).toEqual([
      ["bad", 0.4, 0.28], // ACoS 50 % → max(0.7, 22/50)
      ["dead", 0.2, 0.14], // 50 clics, 3 € sin ventas → −30 %
    ]);
  });

  it("cuts a bad entity even when the country is on target, never below 0,10 €", () => {
    const res = regulate([e("bad", 0.12, 10, 20), e("good", 0.3, 30, 180, 1)]);
    expect(res.mode).toBe("hold");
    expect(res.changes).toEqual([expect.objectContaining({ id: "bad", newBid: 0.1 })]);
  });

  it("raises winners a little every day: +10 % strong, +5 % good, halved above 25 %", () => {
    expect(regulate([e("win", 0.5, 10, 100, 3), e("good", 0.4, 18, 100, 3), e("one", 0.5, 2, 30, 1)]).changes.map((c) => [c.id, c.newBid])).toEqual([
      ["win", 0.55],
      ["good", 0.42],
    ]);
    // country 30 % (above the 25 % limit, under the 35 % brake): winner raise halved
    expect(regulate([e("win", 0.5, 10, 100, 3), e("bad", 0.5, 50, 100, 1)]).changes.find((c) => c.id === "win")?.newBid).toBe(0.53);
    // country 50 % (brake): no raise at all
    expect(regulate([e("win", 0.5, 10, 100, 3), e("bad", 0.5, 90, 100, 1)]).changes.find((c) => c.id === "win")).toBeUndefined();
    expect(regulate([e("x", 0.5, 0, 0, 0)]).mode).toBe("no_data");
  });

  it("pacing under 85 % budget use: profitable +12 %, unexplored up to 0,15 € while country < 30 %", () => {
    const c = (id: string, bid: number, spend: number, sales: number, orders: number, clicks: number) => ({ id, kind: "keyword" as const, label: id, bid, spend, sales, orders, clicks });
    const ents = [c("prof", 0.3, 22, 100, 1, 40), c("new", 0.05, 0.2, 0, 0, 2), c("base", 0.3, 50, 250, 1, 200)];
    const res = regulate(ents, new Set(), 0.4);
    expect(res.changes.map((x) => [x.id, x.newBid])).toEqual([
      ["prof", 0.34],
      ["new", 0.15],
      ["base", 0.34],
    ]);
    expect(regulate(ents, new Set(), 0.9).changes).toEqual([]);
    // country ACoS above the 25 % limit: pacing raises nothing
    const hot = [c("prof", 0.3, 22, 100, 1, 40), c("new", 0.05, 0.2, 0, 0, 2), c("loss", 0.3, 80, 100, 1, 200)];
    expect(regulate(hot, new Set(), 0.4).changes.filter((x) => x.newBid > x.oldBid)).toEqual([]);
  });
});
describe("regulator pause at the bid floor", () => {
  it("pauses a losing entity whose bid is already at or under the floor, and leaves small spenders", () => {
    const base = { kind: "target" as const, label: "t", orders: 0 };
    const r = regulate([
      { ...base, id: "a", bid: 0.05, spend: 17.85, sales: 8.32, clicks: 112, orders: 1 },
      { ...base, id: "b", bid: 0.1, spend: 1.5, sales: 0, clicks: 6 },
      { ...base, id: "c", bid: 0.3, spend: 5, sales: 0, clicks: 20 },
    ]);
    expect(r.changes.find((c) => c.id === "a")?.pause).toBe(true);
    expect(r.changes.find((c) => c.id === "b")).toBeUndefined();
    expect(r.changes.find((c) => c.id === "c")).toMatchObject({ newBid: 0.15 });
    expect(r.changes.find((c) => c.id === "c")?.pause).toBeUndefined();
  });
});

describe("regulator country brake (country ACoS > 35 %)", () => {
  const c = (id: string, bid: number, spend: number, sales: number, clicks: number) => ({ id, kind: "target" as const, label: id, bid, spend, sales, orders: sales > 0 ? 1 : 0, clicks });
  it("only cuts, aiming at 18 % with steps up to −40 %, and cuts no-sale spend harder", () => {
    const r = regulate([c("hi", 0.5, 150, 250, 100), c("mid", 0.5, 20, 100, 60), c("dead2", 0.4, 2.5, 0, 6), c("dead1", 0.4, 1.2, 0, 4), c("win", 0.5, 5, 100, 30)], new Set(), 0.4);
    expect(r.mode).toBe("down");
    expect(r.changes.map((x) => [x.id, x.newBid])).toEqual([
      ["hi", 0.3], // ACoS 60 % → max(0.6, 18/60)
      ["mid", 0.45], // ACoS 20 % > 18 % → ×0.9
      ["dead2", 0.2], // 2,5 € sin ventas → −50 %
      ["dead1", 0.28], // 1,2 € sin ventas → −30 %
    ]);
  });
  it("brakes when there is spend and no sales at all", () => {
    const r = regulate([c("x", 0.4, 3, 0, 10)], new Set(), 0.2);
    expect(r.changes).toEqual([expect.objectContaining({ id: "x", newBid: 0.2 })]);
  });
});
