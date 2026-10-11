import type { NotifyPriority } from "./notify-routing.cjs";
export interface NotificationRecord {
  id?: string;
  userId: string;
  appOwner: string;
  appName: string;
  title: string;
  body?: string;
  url?: string;
  priority: NotifyPriority;
  data?: Record<string, unknown>;
}

export interface DeliveryNotification {
  id: string;
  sequence: number;
  app_owner: string;
  app_name: string;
  title: string;
  body: string | null;
  url: string | null;
  priority: NotifyPriority;
  created_at: string;
}

export interface CommittedNotification {
  id: string;
  userId: string;
  sequence: number;
  eligible: boolean;
  delivery: DeliveryNotification;
}

