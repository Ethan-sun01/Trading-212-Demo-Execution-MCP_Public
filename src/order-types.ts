export type TimeValidity = "DAY" | "GOOD_TILL_CANCEL";

export type MarketOrderBody = {
  ticker: string;
  quantity: number;
  extendedHours: boolean;
};

export type LimitOrderBody = {
  ticker: string;
  quantity: number;
  limitPrice: number;
  timeValidity: TimeValidity;
};

export type StopOrderBody = {
  ticker: string;
  quantity: number;
  stopPrice: number;
  timeValidity: TimeValidity;
};

export type StopLimitOrderBody = {
  ticker: string;
  quantity: number;
  stopPrice: number;
  limitPrice: number;
  timeValidity: TimeValidity;
};

export type MarketOrderIntent = MarketOrderBody & {
  requestId: string;
  referencePrice: number;
  probeConfirmed: boolean;
};

export type LimitOrderIntent = LimitOrderBody & {
  requestId: string;
  probeConfirmed: boolean;
};

export type StopOrderIntent = StopOrderBody & {
  requestId: string;
  referencePrice: number;
  probeConfirmed: boolean;
};

export type StopLimitOrderIntent = StopLimitOrderBody & {
  requestId: string;
  probeConfirmed: boolean;
};

export type PlacementIntent =
  | ({ orderType: "market" } & MarketOrderIntent)
  | ({ orderType: "limit" } & LimitOrderIntent)
  | ({ orderType: "stop" } & StopOrderIntent)
  | ({ orderType: "stop_limit" } & StopLimitOrderIntent);

export type ReplacementOrder =
  | ({ orderType: "market"; referencePrice: number; probeConfirmed: boolean } & MarketOrderBody)
  | ({ orderType: "limit"; probeConfirmed: boolean } & LimitOrderBody)
  | ({ orderType: "stop"; referencePrice: number; probeConfirmed: boolean } & StopOrderBody)
  | ({ orderType: "stop_limit"; probeConfirmed: boolean } & StopLimitOrderBody);

export type ModifyOrderIntent = {
  requestId: string;
  orderId: number;
  replacement: ReplacementOrder;
};

export type CancelOrderIntent = {
  requestId: string;
  orderId: number;
};

export type OrderRecord = Record<string, unknown> & {
  id?: number;
  ticker?: string;
  quantity?: number;
  status?: string;
  filledQuantity?: number;
  side?: string;
};

export class Trading212RequestError extends Error {
  readonly ambiguous: boolean;
  declare readonly status?: number;
  declare readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    ambiguous: boolean,
    status?: number,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "Trading212RequestError";
    this.ambiguous = ambiguous;
    if (status !== undefined) this.status = status;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}
