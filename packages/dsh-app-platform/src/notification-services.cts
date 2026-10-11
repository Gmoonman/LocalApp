import { NotificationStore, type NotificationPersistence } from "./notifications.cjs";
import { NotificationDeliveryStore, type NotificationDeliveryPersistence } from "./notification-delivery.cjs";
import { SubscriptionStore } from "./subscriptions.cjs";
export interface NotificationServices {
  notifications: NotificationStore;
  delivery: NotificationDeliveryStore;
  subscriptions: SubscriptionStore;
}
/** All notification entry points share one transaction and subscription state. */
export function createNotificationServices(persistence: NotificationDeliveryPersistence,
  sendToUser: NotificationPersistence["sendToUser"]): NotificationServices {
  const delivery = new NotificationDeliveryStore(persistence);
  return {
    delivery,
    subscriptions: new SubscriptionStore(persistence),
    notifications: new NotificationStore({ ...persistence, sendToUser,
      commitNotificationBatch: records => delivery.commitNotificationBatch(records) }),
  };
}
