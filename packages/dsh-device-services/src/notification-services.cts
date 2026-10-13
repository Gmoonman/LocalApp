import { NotificationStore, type NotificationPersistence } from "@localapp/dsh-device-services/notifications";
import { NotificationDeliveryStore, type NotificationDeliveryPersistence } from "@localapp/dsh-device-services/notification-delivery";
import { SubscriptionStore } from "@localapp/dsh-device-services/subscriptions";
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
