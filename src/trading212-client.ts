import { assertDemoBaseUrl, type Trading212Config } from "./config.js";
import {
  Trading212RequestError,
  type LimitOrderBody,
  type MarketOrderBody,
  type OrderRecord,
  type StopLimitOrderBody,
  type StopOrderBody,
} from "./order-types.js";

type JsonRecord = Record<string, unknown>;

type OrderHistoryOptions = {
  limit?: number;
  cursor?: number;
  ticker?: string;
};

type TransactionOptions = {
  limit?: number;
  cursor?: string;
  time?: string;
};

type SendOptions = {
  query?: URLSearchParams;
  body?: unknown;
};

const IMF_FIXDATE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

function assertLimit(limit: number, maximum: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`limit must be between 1 and ${maximum}`);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds : undefined;
  }
  if (!IMF_FIXDATE.test(trimmed)) return undefined;
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp) || new Date(timestamp).toUTCString() !== trimmed) {
    return undefined;
  }
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000));
}

function getRateLimitResetSeconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return undefined;
  const resetTimestampSeconds = Number(trimmed);
  if (!Number.isFinite(resetTimestampSeconds)) return undefined;
  return Math.max(0, Math.ceil(resetTimestampSeconds - Date.now() / 1_000));
}

export class Trading212Client {
  constructor(
    private readonly config: Trading212Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request<T = unknown>(
    path: string,
    query?: URLSearchParams,
  ): Promise<T> {
    return this.send<T>("GET", path, query === undefined ? undefined : { query });
  }

  private async send<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options?: SendOptions,
  ): Promise<T> {
    assertDemoBaseUrl(this.config.baseUrl);
    const credentials = Buffer.from(
      `${this.config.apiKey}:${this.config.apiSecret}`,
    ).toString("base64");
    const queryString = options?.query?.toString();
    const url = `${this.config.baseUrl}${path}${queryString ? `?${queryString}` : ""}`;
    const headers: Record<string, string> = {
      authorization: `Basic ${credentials}`,
    };
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    };
    if (options?.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch {
      throw new Trading212RequestError(
        "Trading 212 request failed before receiving a response",
        true,
      );
    }
    if (!response.ok) {
      const knownErrors: Record<number, string> = {
        400: "Trading 212 rejected the request (400)",
        401: "Trading 212 authentication failed (401)",
        403: "Trading 212 permission denied (403)",
        404: "Trading 212 order not found (404)",
        408: "Trading 212 request timed out (408)",
        429: "Trading 212 rate limit exceeded (429)",
      };
      const message =
        knownErrors[response.status] ??
        `Trading 212 request failed (${response.status})`;
      const retryAfterSeconds =
        response.status === 429
          ? getRetryAfterSeconds(response.headers.get("retry-after")) ??
            getRateLimitResetSeconds(response.headers.get("x-ratelimit-reset"))
          : undefined;
      throw new Trading212RequestError(
        message,
        response.status === 408 || response.status >= 500,
        response.status,
        retryAfterSeconds,
      );
    }
    const responseProcessingError = () =>
      new Trading212RequestError(
        "Trading 212 response could not be processed",
        method !== "GET",
        response.status,
      );
    const isEmpty =
      response.status === 204 || response.headers.get("content-length") === "0";
    if (isEmpty) {
      if (method === "POST") throw responseProcessingError();
      return undefined as T;
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw responseProcessingError();
    }
    if (!text) {
      if (method === "POST") throw responseProcessingError();
      return undefined as T;
    }
    try {
      const value: unknown = JSON.parse(text);
      if (method === "POST" && !isRecord(value)) {
        throw responseProcessingError();
      }
      return value as T;
    } catch {
      throw responseProcessingError();
    }
  }

  async placeMarketOrder(body: MarketOrderBody): Promise<OrderRecord> {
    return this.send<OrderRecord>("POST", "/equity/orders/market", { body });
  }

  async placeLimitOrder(body: LimitOrderBody): Promise<OrderRecord> {
    return this.send<OrderRecord>("POST", "/equity/orders/limit", { body });
  }

  async placeStopOrder(body: StopOrderBody): Promise<OrderRecord> {
    return this.send<OrderRecord>("POST", "/equity/orders/stop", { body });
  }

  async placeStopLimitOrder(body: StopLimitOrderBody): Promise<OrderRecord> {
    return this.send<OrderRecord>("POST", "/equity/orders/stop_limit", {
      body,
    });
  }

  async cancelOrder(id: number): Promise<void> {
    if (!Number.isInteger(id) || id < 1) {
      throw new Error("order ID must be a positive integer");
    }
    return this.send<void>("DELETE", `/equity/orders/${id}`);
  }

  async getAccountSummary(): Promise<JsonRecord> {
    return this.request<JsonRecord>("/equity/account/summary");
  }

  async getCash(): Promise<unknown> {
    const account = await this.getAccountSummary();
    return account.cash;
  }

  async getPositions(): Promise<JsonRecord[]> {
    return this.request<JsonRecord[]>("/equity/portfolio");
  }

  async getPosition(ticker: string): Promise<JsonRecord | null> {
    const positions = await this.getPositions();
    return positions.find((position) => position.ticker === ticker) ?? null;
  }

  async getOpenOrders(): Promise<JsonRecord[]> {
    return this.request<JsonRecord[]>("/equity/orders");
  }

  async getOrder(id: number): Promise<JsonRecord> {
    if (!Number.isInteger(id) || id < 1) {
      throw new Error("order ID must be a positive integer");
    }
    return this.request<JsonRecord>(`/equity/orders/${id}`);
  }

  async getOrderHistory(
    options: OrderHistoryOptions = {},
  ): Promise<JsonRecord> {
    const limit = options.limit ?? 20;
    assertLimit(limit, 50);
    const query = new URLSearchParams({ limit: String(limit) });
    if (options.cursor !== undefined) {
      query.set("cursor", String(options.cursor));
    }
    if (options.ticker !== undefined) query.set("ticker", options.ticker);
    return this.request<JsonRecord>("/equity/history/orders", query);
  }

  async getTransactions(
    options: TransactionOptions = {},
  ): Promise<JsonRecord> {
    const limit = options.limit ?? 20;
    assertLimit(limit, 50);
    if (options.time !== undefined && Number.isNaN(Date.parse(options.time))) {
      throw new Error("time must be a valid ISO date-time");
    }
    const query = new URLSearchParams({ limit: String(limit) });
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    if (options.time !== undefined) query.set("time", options.time);
    return this.request<JsonRecord>("/equity/history/transactions", query);
  }

  async getInstruments(): Promise<JsonRecord[]> {
    return this.request<JsonRecord[]>("/equity/metadata/instruments");
  }

  async searchInstruments(
    search: string,
    limit = 10,
  ): Promise<JsonRecord[]> {
    assertLimit(limit, 25);
    const term = search.toLowerCase();
    const instruments = await this.getInstruments();
    return instruments
      .filter((instrument) => {
        const ticker =
          typeof instrument.ticker === "string" ? instrument.ticker : "";
        const name = typeof instrument.name === "string" ? instrument.name : "";
        return ticker.toLowerCase().includes(term) || name.toLowerCase().includes(term);
      })
      .slice(0, limit);
  }

  async getExchanges(): Promise<JsonRecord[]> {
    const value = await this.request<unknown>("/equity/metadata/exchanges");
    return Array.isArray(value) ? value.filter(isRecord) : [];
  }

  async getBrokerSnapshot(): Promise<JsonRecord> {
    const [account, positions, openOrders] = await Promise.all([
      this.getAccountSummary(),
      this.getPositions(),
      this.getOpenOrders(),
    ]);
    return {
      capturedAt: new Date().toISOString(),
      account,
      cash: account.cash,
      positions,
      openOrders,
    };
  }
}
