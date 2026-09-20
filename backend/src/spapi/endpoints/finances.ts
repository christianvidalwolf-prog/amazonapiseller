import type { SpApiClient } from "../client";

export interface TransactionAmount {
  currencyAmount: number;
  currencyCode: string;
}

export interface TransactionItem {
  transactionType: string;
  transactionId: string;
  transactionStatus?: string;
  description?: string;
  postedDate?: string;
  totalAmount?: TransactionAmount;
  marketplaceDetails?: {
    marketplaceId?: string;
    marketplaceName?: string;
  };
  relatedIdentifiers?: Array<{
    relatedIdentifierName?: string;
    relatedIdentifierValue?: string;
  }>;
  breakdowns?: Array<{
    breakdownType?: string;
    breakdownAmount?: TransactionAmount;
  }>;
}

export interface TransactionsResponse {
  payload?: {
    transactions?: TransactionItem[];
    nextToken?: string;
  };
  nextToken?: string;
}

/** GET /finances/2024-06-19/transactions (Finances API v2024). */
export async function listTransactions(
  client: SpApiClient,
  params: { postedAfter: string; postedBefore?: string; nextToken?: string }
): Promise<TransactionsResponse> {
  return client.request<TransactionsResponse>({
    method: "GET",
    path: "/finances/2024-06-19/transactions",
    query: {
      postedAfter: params.postedAfter,
      postedBefore: params.postedBefore,
      nextToken: params.nextToken,
    },
    rateLimitKey: "finances.listFinancialEvents",
  });
}
