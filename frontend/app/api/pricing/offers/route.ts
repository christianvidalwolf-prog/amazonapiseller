import { NextRequest, NextResponse } from "next/server";
import { snapshotResponse } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

const REGION_URLS: Record<string, string> = {
  EU: "https://sellingpartnerapi-eu.amazon.com",
  NA: "https://sellingpartnerapi-na.amazon.com",
  FE: "https://sellingpartnerapi-fe.amazon.com",
};

const MARKETPLACE_DOMAINS: Record<string, string> = {
  A1RKKUPIHCS9HS: "www.amazon.es",
  A1PA6795UKMFR9: "www.amazon.de",
  A13V1IB3VIYZZH: "www.amazon.fr",
  APJ6JRA9NG5V4: "www.amazon.it",
  A1F83G8C2ARO7P: "www.amazon.co.uk",
  A1805IZSGTT6HS: "www.amazon.nl",
  AMEN7PMS3EDWL: "www.amazon.com.be",
  A1C3SOZRARQ6R3: "www.amazon.pl",
  A2NODRKZP88ZB9: "www.amazon.se",
  ATVPDKIKX0DER: "www.amazon.com",
};

async function getLwaAccessToken(): Promise<string> {
  const clientId = process.env.LWA_CLIENT_ID?.trim();
  const clientSecret = process.env.LWA_CLIENT_SECRET?.trim();
  const refreshToken = process.env.SP_API_REFRESH_TOKEN?.trim();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Credenciales de Amazon SP-API no configuradas en el entorno (LWA_CLIENT_ID, LWA_CLIENT_SECRET, SP_API_REFRESH_TOKEN).");
  }

  const res = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Error autenticando con Amazon LWA (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function fetchLiveOffersFromAmazon(asin: string) {
  const token = await getLwaAccessToken();
  const region = (process.env.SP_API_REGION || "EU").toUpperCase();
  const baseUrl = REGION_URLS[region] || REGION_URLS.EU;
  const marketplaceId = process.env.SP_API_DEFAULT_MARKETPLACE_ID || "A1RKKUPIHCS9HS";
  const mySellerId = process.env.SP_API_SELLER_ID?.trim() || "";

  const url = `${baseUrl}/products/pricing/v0/items/${encodeURIComponent(asin)}/offers?MarketplaceId=${encodeURIComponent(marketplaceId)}&ItemCondition=New&CustomerType=Consumer`;
  const res = await fetch(url, {
    headers: {
      "x-amz-access-token": token,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Amazon SP-API error (${res.status}): ${text}`);
  }

  const json = await res.json();
  const payload = (json.payload as Record<string, unknown>) || {};
  const summary = (payload.Summary as Record<string, unknown>) || {};
  const buyBoxPrices = (summary.BuyBoxPrices as Array<Record<string, unknown>>) || [];

  let buyBoxPrice: number | null = null;
  let currency = "EUR";
  if (buyBoxPrices.length > 0) {
    const landed = (buyBoxPrices[0].LandedPrice as Record<string, unknown>) || {};
    buyBoxPrice = Number(landed.Amount) || null;
    currency = String(landed.CurrencyCode || "EUR");
  }

  const rawOffers = (payload.Offers as Array<Record<string, unknown>>) || [];
  const domain = MARKETPLACE_DOMAINS[marketplaceId] || "www.amazon.es";
  const offers = [];

  for (const ro of rawOffers) {
    const isBuyBoxWinner = Boolean(ro.IsBuyBoxWinner);
    const isFulfilledByAmazon = Boolean(ro.IsFulfilledByAmazon);
    const listPriceObj = (ro.ListingPrice as Record<string, unknown>) || {};
    const shipPriceObj = (ro.Shipping as Record<string, unknown>) || {};
    const feedbackObj = (ro.SellerFeedbackRating as Record<string, unknown>) || {};
    const shipsFromObj = (ro.ShipsFrom as Record<string, unknown>) || {};

    const listingPrice = Number(listPriceObj.Amount) || 0;
    const shippingPrice = Number(shipPriceObj.Amount) || 0;
    const totalPrice = Number((listingPrice + shippingPrice).toFixed(2));
    const curr = String(listPriceObj.CurrencyCode || currency);

    const feedbackCount = Number(feedbackObj.FeedbackCount) || 0;
    const positiveFeedbackRating =
      feedbackObj.PositiveFeedbackRating !== undefined ? Number(feedbackObj.PositiveFeedbackRating) : null;
    const shipsFromCountry = shipsFromObj.Country ? String(shipsFromObj.Country) : null;
    const condition = String(ro.SubCondition || "New");

    const priceDifference = buyBoxPrice !== null ? Number((totalPrice - buyBoxPrice).toFixed(2)) : null;
    const sellerId = typeof ro.SellerId === "string" && ro.SellerId.trim() ? ro.SellerId.trim() : null;
    const sellerUrl = sellerId
      ? `https://${domain}/sp?${new URLSearchParams({ seller: sellerId, marketplaceID: marketplaceId })}`
      : null;

    offers.push({
      sellerId,
      sellerUrl,
      isMyOffer: ro.MyOffer === true || Boolean(sellerId && mySellerId && sellerId === mySellerId),
      isBuyBoxWinner,
      isFulfilledByAmazon,
      listingPrice,
      shippingPrice,
      totalPrice,
      currency: curr,
      feedbackCount,
      positiveFeedbackRating,
      shipsFromCountry,
      condition,
      priceDifference,
    });
  }

  // Ordenar ofertas: primero la ganadora de la Buy Box, luego por precio total ascendente
  offers.sort((a, b) => {
    if (a.isBuyBoxWinner && !b.isBuyBoxWinner) return -1;
    if (!a.isBuyBoxWinner && b.isBuyBoxWinner) return 1;
    return a.totalPrice - b.totalPrice;
  });

  return {
    asin,
    buyBoxPrice,
    currency,
    totalOffersCount: offers.length,
    offers,
  };
}

export async function GET(req: NextRequest) {
  const asin = (req.nextUrl.searchParams.get("asin") || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    return NextResponse.json({ error: "invalid_asin", message: "Indica un ASIN válido." }, { status: 400 });
  }

  // 1. Si las credenciales SP-API están configuradas en el entorno (Vercel o local), consultar en vivo
  if (process.env.LWA_CLIENT_ID && process.env.LWA_CLIENT_SECRET && process.env.SP_API_REFRESH_TOKEN) {
    try {
      const data = await fetchLiveOffersFromAmazon(asin);
      return NextResponse.json(data);
    } catch (liveErr) {
      console.warn(`[pricing:offers] Live SP-API fetch failed for ${asin}, falling back to snapshot/backend:`, liveErr);
    }
  }

  // 2. Si no están configuradas o falló, buscar en Supabase snapshots o proxy a backend local
  return snapshotResponse(`pricing:offers:${asin}`, `/api/pricing/offers?asin=${encodeURIComponent(asin)}`);
}
