import type { SpApiClient } from "../client";

export interface DestinationResponse {
  payload: { destinationId: string };
}

/** POST /notifications/v1/destinations — register the SQS/EventBridge target once. */
export async function createDestination(
  client: SpApiClient,
  params: { name: string; sqsArn: string }
): Promise<DestinationResponse> {
  return client.request<DestinationResponse>({
    method: "POST",
    path: "/notifications/v1/destinations",
    body: { name: params.name, resourceSpecification: { sqs: { arn: params.sqsArn } } },
    rateLimitKey: "notifications.createSubscription",
  });
}

/** POST /notifications/v1/subscriptions/{notificationType} — e.g. ANY_OFFER_CHANGED. */
export async function createSubscription(
  client: SpApiClient,
  params: { notificationType: "ANY_OFFER_CHANGED"; destinationId: string; marketplaceIds: string[] }
): Promise<{ payload: { subscriptionId: string } }> {
  return client.request({
    method: "POST",
    path: `/notifications/v1/subscriptions/${params.notificationType}`,
    body: { payloadVersion: "1.0", destinationId: params.destinationId },
    rateLimitKey: "notifications.createSubscription",
  });
}
