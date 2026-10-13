import { notificationServices } from "./notification-state.js";
const subscriptions = notificationServices.subscriptions;
export type { SubscriptionLevel, SubscriptionRecord } from "@localapp/dsh-device-services/subscriptions";
export const upsertSubscription = subscriptions.upsertSubscription.bind(subscriptions);
export const deleteSubscription = subscriptions.deleteSubscription.bind(subscriptions);
export const listSubscriptionsByUser = subscriptions.listSubscriptionsByUser.bind(subscriptions);
export const getSubscriptionStatus = subscriptions.getSubscriptionStatus.bind(subscriptions);
