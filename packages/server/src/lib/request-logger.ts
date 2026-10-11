import { RequestLogger } from "@localapp/dsh-app-platform/request-logger";
import { insertRequestLogs, insertPageViews } from "./meta-sqlite.js";
import { guardTimerCallback } from "./timer-guard.js";
export const requestLogger = new RequestLogger({ insertRequestLogs, insertPageViews,
  onError: error => guardTimerCallback("request log flush", () => { throw error; })(),
});
export const pushRequestLog = requestLogger.pushRequestLog.bind(requestLogger);
export const listRecentRequestLogs = requestLogger.listRecentRequestLogs.bind(requestLogger);
export const pushPageView = requestLogger.pushPageView.bind(requestLogger);
export const startRequestLogger = requestLogger.startRequestLogger.bind(requestLogger);
export const stopRequestLogger = requestLogger.stopRequestLogger.bind(requestLogger);
