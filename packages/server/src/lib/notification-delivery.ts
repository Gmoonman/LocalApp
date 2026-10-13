import { notificationServices } from "./notification-state.js";
const delivery = notificationServices.delivery;
export type { NotificationRecord, DeliveryNotification, CommittedNotification, DeliveryPage, ListDeliveryOptions } from "@localapp/dsh-device-services/notification-delivery";
export const getNotificationDeliveryHighWater = delivery.getNotificationDeliveryHighWater.bind(delivery);
export const commitNotificationBatch = delivery.commitNotificationBatch.bind(delivery);
export const listDeliverableNotifications = delivery.listDeliverableNotifications.bind(delivery);
