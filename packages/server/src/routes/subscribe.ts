import type { FastifyInstance } from "fastify";
import { registerApplicationSubscriptions, type SubscriptionRoutesHost } from "@localapp/dsh-app-platform/subscription-routes";
import { upsertSubscription, deleteSubscription, listSubscriptionsByUser, getSubscriptionStatus } from "../lib/subscriptions-db.js";
export function createSubscriptionRoutesHost(): SubscriptionRoutesHost {
  return { userId: req => req.visitorId || req.userId || null,
    store: { upsertSubscription, deleteSubscription, listSubscriptionsByUser, getSubscriptionStatus } };
}
export async function subscribeRoutes(app: FastifyInstance) {
  await registerApplicationSubscriptions(app, createSubscriptionRoutesHost());
}
