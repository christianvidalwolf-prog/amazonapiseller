import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const REGION_URLS: Record<string, string> = {
  EU: "https://sellingpartnerapi-eu.amazon.com",
  NA: "https://sellingpartnerapi-na.amazon.com",
  FE: "https://sellingpartnerapi-fe.amazon.com",
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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sku: string }> }
) {
  try {
    const { sku } = await params;
    const body = await request.json();
    const backendUrl = process.env.BACKEND_API_URL?.trim() || "http://localhost:4000";

    // Route to Express backend which manages Amazon SP-API credentials, rate limiting, and tokens
    try {
      const backendResponse = await fetch(`${backendUrl}/api/listings/items/${encodeURIComponent(sku)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(60000),
      });

      if (backendResponse.ok) {
        const responseBody = await backendResponse.json();
        return NextResponse.json(responseBody, { status: 200 });
      }

      // If backend returned 422 or error response from Amazon, parse and propagate
      const errorBody = await backendResponse.json().catch(() => ({}));
      const firstIssue = errorBody.issues?.[0]?.message;
      const firstError = errorBody.errors?.[0]?.message;
      const errorMsg = errorBody.error || firstIssue || firstError || "Amazon no aceptó la actualización.";
      return NextResponse.json(
        { error: errorMsg, ...errorBody },
        { status: backendResponse.status || 422 }
      );
    } catch (backendErr) {
      // Backend not reachable, fall back to direct SP-API if credentials configured
      if (!process.env.LWA_CLIENT_ID || !process.env.LWA_CLIENT_SECRET || !process.env.SP_API_REFRESH_TOKEN) {
        return NextResponse.json(
          { error: `No se pudo conectar con el servidor backend (${backendErr instanceof Error ? backendErr.message : "error"}). Verifique que el servicio backend esté activo.` },
          { status: 502 }
        );
      }
    }

    const { price, stock, leadTimeDays, marketplaceId, currency = "EUR" } = body;

    const sellerId = process.env.SP_API_SELLER_ID || "A3RY0L9OY3TPHI";
    const region = (process.env.SP_API_REGION || "EU").toUpperCase();
    const baseUrl = REGION_URLS[region] || REGION_URLS.EU;
    const targetMarketplaceId = marketplaceId || process.env.SP_API_MARKETPLACE_IDS?.split(",")[0] || "A1RKKUPIHCS9HS";

    const patches: Array<{ op: string; path: string; value: unknown }> = [];

    if (typeof price === "number" || (price && !Number.isNaN(Number(price)))) {
      const numPrice = Number(price);
      patches.push({
        op: "replace",
        path: "/attributes/purchasable_offer",
        value: [
          {
            currency,
            marketplace_id: targetMarketplaceId,
            our_price: [
              {
                schedule: [
                  {
                    value_with_tax: Number(numPrice.toFixed(2)),
                  },
                ],
              },
            ],
          },
        ],
      });
    }

    if (typeof stock === "number" || (stock !== undefined && stock !== "" && !Number.isNaN(Number(stock)))) {
      const numStock = Math.floor(Number(stock));
      patches.push({
        op: "replace",
        path: "/attributes/fulfillment_availability",
        value: [
          {
            fulfillment_channel_code: "DEFAULT",
            quantity: numStock,
            lead_time_to_ship_max_days: Number(leadTimeDays) || 2,
          },
        ],
      });
    }

    if (patches.length === 0) {
      return NextResponse.json(
        { error: "Debes proporcionar al menos precio o stock para actualizar." },
        { status: 400 }
      );
    }

    const token = await getLwaAccessToken();
    const amazonUrl = `${baseUrl}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}?marketplaceIds=${targetMarketplaceId}`;

    const patchPayload = {
      productType: "PRODUCT",
      patches,
    };

    const spRes = await fetch(amazonUrl, {
      method: "PATCH",
      headers: {
        "x-amz-access-token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patchPayload),
    });

    const spData = await spRes.json();

    if (!spRes.ok) {
      const firstIssue = spData.issues?.[0]?.message;
      const firstError = spData.errors?.[0]?.message;
      const errorMessage = firstIssue || firstError || spData.message || "Error al actualizar en Amazon SP-API";
      return NextResponse.json(
        { error: errorMessage, raw: spData },
        { status: spRes.status }
      );
    }

    // Check if Amazon returned issues in a 200/202 response
    if (spData.status === "INVALID" || (Array.isArray(spData.issues) && spData.issues.some((i: { severity: string }) => i.severity === "ERROR"))) {
      const errorMsg = spData.issues?.find((i: { severity: string }) => i.severity === "ERROR")?.message || "Amazon rechazó la actualización del precio";
      return NextResponse.json(
        { error: errorMsg, submissionId: spData.submissionId, status: spData.status, issues: spData.issues },
        { status: 422 }
      );
    }

    return NextResponse.json({
      success: true,
      submissionId: spData.submissionId,
      status: spData.status || "ACCEPTED",
      raw: spData,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error interno al procesar actualización" },
      { status: 500 }
    );
  }
}
