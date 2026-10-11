import type { RequestLogEntry, PageViewEntry, AnalyticsStore } from "./analytics.cjs";
export interface RequestLoggerHost extends Pick<AnalyticsStore, "insertRequestLogs" | "insertPageViews"> { onError(error: unknown): void }
const FLUSH_INTERVAL_MS = 5_000;
const MAX_BUFFER_SIZE = 100;
export class RequestLogger {
  private requestBuffer: RequestLogEntry[] = [];
  private pageViewBuffer: PageViewEntry[] = [];
  private readonly recentRequestBuffer: Array<{ scope: string | null; entry: RequestLogEntry }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly host: RequestLoggerHost) {}
  private flush(): void {
    const requests = this.requestBuffer;
    const views = this.pageViewBuffer;
    this.requestBuffer = [];
    this.pageViewBuffer = [];
    try {
      this.host.insertRequestLogs(requests);
      this.host.insertPageViews(views);
    } catch (error) {
      // Logging should never crash the server, but swallowing a terminal SQLite
      // trap here is how a single trap stayed invisible while every database
      // request failed for the next 46 minutes.
      this.host.onError(error);
    }
  }

  pushRequestLog(entry: RequestLogEntry, scope?: string): void {
    this.requestBuffer.push(entry);
    this.recentRequestBuffer.push({ scope: scope ?? null, entry });
    if (this.recentRequestBuffer.length > 200) this.recentRequestBuffer.splice(0, this.recentRequestBuffer.length - 200);
    if (this.requestBuffer.length >= MAX_BUFFER_SIZE) this.flush();
  }

  listRecentRequestLogs(scope?: string): RequestLogEntry[] {
    return this.recentRequestBuffer
      .filter((item) => scope === undefined || item.scope === scope)
      .map((item) => item.entry)
      .reverse();
  }

  pushPageView(entry: PageViewEntry): void {
    this.pageViewBuffer.push(entry);
    if (this.pageViewBuffer.length >= MAX_BUFFER_SIZE) this.flush();
  }

  startRequestLogger(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  stopRequestLogger(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}
