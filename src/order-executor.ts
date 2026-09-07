import type { ExecutionJournal, JournalRecord } from "./execution-journal.js";
import type { ExecutionPolicyGate } from "./execution-policy.js";
import { Trading212RequestError, type CancelOrderIntent, type LimitOrderBody, type LimitOrderIntent, type MarketOrderBody, type MarketOrderIntent, type ModifyOrderIntent, type OrderRecord, type PlacementIntent, type ReplacementOrder, type StopLimitOrderBody, type StopLimitOrderIntent, type StopOrderBody, type StopOrderIntent } from "./order-types.js";

export type OrderClient = {
  getOrder(id: number): Promise<OrderRecord>;
  getOpenOrders(): Promise<unknown>;
  getOrderHistory(options: { limit: 50 }): Promise<unknown>;
  placeMarketOrder(body: MarketOrderBody): Promise<OrderRecord>;
  placeLimitOrder(body: LimitOrderBody): Promise<OrderRecord>;
  placeStopOrder(body: StopOrderBody): Promise<OrderRecord>;
  placeStopLimitOrder(body: StopLimitOrderBody): Promise<OrderRecord>;
  cancelOrder(id: number): Promise<void>;
};
type ExecutionGate = Pick<ExecutionPolicyGate, "requireEnabled" | "validatePlacement" | "validateMutationBudget">;
type PlacementInput = MarketOrderIntent | LimitOrderIntent | StopOrderIntent | StopLimitOrderIntent;
type ReplayInput = PlacementInput | CancelOrderIntent | ModifyOrderIntent;
type Wait = (milliseconds: number) => Promise<void>;
export type ExecutionEnvelope = { environment: "demo"; requestId: string; replayed: boolean; outcome: "succeeded" | "failed" | "uncertain" | "cancelled_without_replacement"; order?: unknown; message?: string; status?: number; retryAfterSeconds?: number; cancelledOrderId?: number; replacementOrder?: unknown };
const INCOMPLETE_MESSAGE = "existing request has an incomplete execution record";
const UNCERTAIN_MESSAGE = "Trading 212 execution outcome is uncertain";
const FAILED_MESSAGE = "Trading 212 request failed";
const UNUSABLE_ORDER_MESSAGE = "Trading 212 returned an unusable order response";
const CANCELLATION_UNCONFIRMED_MESSAGE = "Trading 212 cancellation could not be confirmed";
const CANCELLATION_STATE_MESSAGE = "Trading 212 cancellation state is unavailable";
const CANCELLABLE_STATUSES = new Set(["LOCAL", "UNCONFIRMED", "CONFIRMED", "NEW"]);

export class OrderExecutor {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly client: OrderClient, private readonly gate: ExecutionGate, private readonly journal?: ExecutionJournal, private readonly wait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {}

  placeMarketOrder(intent: MarketOrderIntent): Promise<ExecutionEnvelope> { return this.serialized(() => this.place("placeMarketOrder", { ...intent, orderType: "market" }, intent, () => this.client.placeMarketOrder({ ticker: intent.ticker, quantity: intent.quantity, extendedHours: intent.extendedHours }))); }
  placeLimitOrder(intent: LimitOrderIntent): Promise<ExecutionEnvelope> { return this.serialized(() => this.place("placeLimitOrder", { ...intent, orderType: "limit" }, intent, () => this.client.placeLimitOrder({ ticker: intent.ticker, quantity: intent.quantity, limitPrice: intent.limitPrice, timeValidity: intent.timeValidity }))); }
  placeStopOrder(intent: StopOrderIntent): Promise<ExecutionEnvelope> { return this.serialized(() => this.place("placeStopOrder", { ...intent, orderType: "stop" }, intent, () => this.client.placeStopOrder({ ticker: intent.ticker, quantity: intent.quantity, stopPrice: intent.stopPrice, timeValidity: intent.timeValidity }))); }
  placeStopLimitOrder(intent: StopLimitOrderIntent): Promise<ExecutionEnvelope> { return this.serialized(() => this.place("placeStopLimitOrder", { ...intent, orderType: "stop_limit" }, intent, () => this.client.placeStopLimitOrder({ ticker: intent.ticker, quantity: intent.quantity, stopPrice: intent.stopPrice, limitPrice: intent.limitPrice, timeValidity: intent.timeValidity }))); }

  cancelOrder(intent: CancelOrderIntent): Promise<ExecutionEnvelope> {
    return this.serialized(async () => {
      const journal = this.requireJournal();
      const existing = await journal.get(intent.requestId);
      if (existing) return this.replayExisting(journal, "cancelOrder", intent, existing);
      assertPositiveInteger(intent.orderId);
      const order = await this.client.getOrder(intent.orderId);
      assertCancellableOrder(order, intent.orderId);
      await this.gate.validateMutationBudget(1);
      const reservation = await journal.reserve("cancelOrder", intent.requestId, intent);
      if (!reservation.created) return this.replay(reservation.record, intent);
      await journal.markDispatched(intent.requestId, 1);
      try { await this.client.cancelOrder(intent.orderId); }
      catch (error) { return this.recordError(journal, intent.requestId, error); }
      const envelope: ExecutionEnvelope = { environment: "demo", requestId: intent.requestId, replayed: false, outcome: "succeeded", order: { accepted: true, orderId: intent.orderId }, cancelledOrderId: intent.orderId };
      const stored = await journal.markSucceeded(intent.requestId, envelope);
      return this.envelopeFromTerminal(stored, false, intent);
    });
  }

  modifyOrder(intent: ModifyOrderIntent): Promise<ExecutionEnvelope> { return this.serialized(() => this.modify(intent)); }

  private async modify(intent: ModifyOrderIntent): Promise<ExecutionEnvelope> {
    const journal = this.requireJournal();
    assertModifyIntent(intent);
    const existing = await journal.get(intent.requestId);
    if (existing) return this.replayExisting(journal, "modifyOrder", intent, existing);
    const original = await this.client.getOrder(intent.orderId);
    assertCancellableOrder(original, intent.orderId);
    const replacementIntent = placementFromReplacement(intent);
    await this.gate.validatePlacement(replacementIntent, 2);
    const reservation = await journal.reserve("modifyOrder", intent.requestId, intent);
    if (!reservation.created) return this.replay(reservation.record, intent);
    await journal.markDispatched(intent.requestId, 1);
    try { await this.client.cancelOrder(intent.orderId); }
    catch (error) { return this.recordError(journal, intent.requestId, error); }
    const cancellation = await this.confirmCancellation(intent.orderId);
    if (cancellation !== "confirmed") return this.recordModifyUncertain(journal, intent, cancellation, false);
    await journal.markDispatched(intent.requestId, 2);
    let replacement: OrderRecord;
    try { replacement = await this.sendReplacement(intent.replacement); }
    catch (error) {
      if (error instanceof Trading212RequestError && !error.ambiguous) return this.recordCancelledWithoutReplacement(journal, intent, error);
      return this.recordModifyUncertain(journal, intent, error, true);
    }
    const summary = projectPlacementOrder(replacement, replacementIntent);
    if (!summary) return this.recordModifyUncertain(journal, intent, UNUSABLE_ORDER_MESSAGE, true);
    const envelope: ExecutionEnvelope = { environment: "demo", requestId: intent.requestId, replayed: false, outcome: "succeeded", cancelledOrderId: intent.orderId, replacementOrder: summary };
    const stored = await journal.markSucceeded(intent.requestId, envelope);
    return this.envelopeFromTerminal(stored, false, intent);
  }

  private async place(toolName: string, taggedIntent: PlacementIntent, input: PlacementInput, send: () => Promise<OrderRecord>): Promise<ExecutionEnvelope> {
    const journal = this.requireJournal();
    const existing = await journal.get(input.requestId);
    if (existing) return this.replayExisting(journal, toolName, input, existing);
    await this.gate.validatePlacement(taggedIntent, 1);
    const reservation = await journal.reserve(toolName, input.requestId, input);
    if (!reservation.created) return this.replay(reservation.record, input);
    await journal.markDispatched(input.requestId, 1);
    let order: OrderRecord;
    try { order = await send(); } catch (error) { return this.recordError(journal, input.requestId, error); }
    const summary = projectPlacementOrder(order, input);
    if (!summary) return this.recordUnusableOrder(journal, input.requestId);
    const envelope: ExecutionEnvelope = { environment: "demo", requestId: input.requestId, replayed: false, outcome: "succeeded", order: summary };
    const stored = await journal.markSucceeded(input.requestId, envelope);
    return this.envelopeFromTerminal(stored, false, input);
  }

  private requireJournal(): ExecutionJournal { this.gate.requireEnabled(); if (!this.journal) throw new Error("Trading 212 execution journal is unavailable"); return this.journal; }
  private async replayExisting(journal: ExecutionJournal, toolName: string, input: ReplayInput, existing: JournalRecord): Promise<ExecutionEnvelope> { const reservation = await journal.reserve(toolName, existing.requestId, input); return this.replay(reservation.record, input); }
  private replay(record: JournalRecord, input: ReplayInput): ExecutionEnvelope { if (record.phase === "reserved" || record.phase === "dispatched") return { environment: "demo", requestId: input.requestId, replayed: true, outcome: "uncertain", message: INCOMPLETE_MESSAGE }; return this.envelopeFromTerminal(record, true, input); }
  private envelopeFromTerminal(record: JournalRecord, replayed: boolean, input?: ReplayInput): ExecutionEnvelope { const raw = record.result; if (!isRecord(raw)) throw new Error("execution journal result is corrupt"); const envelope = sanitizeEnvelope(raw); return { ...envelope, requestId: record.requestId, replayed }; }

  private async recordError(journal: ExecutionJournal, requestId: string, error: unknown): Promise<ExecutionEnvelope> {
    if (error instanceof Trading212RequestError && !error.ambiguous) {
      const message = safeMessage(error.message);
      const envelope: ExecutionEnvelope = { environment: "demo", requestId, replayed: false, outcome: "failed", message, ...(typeof error.status === "number" ? { status: error.status } : {}), ...(typeof error.retryAfterSeconds === "number" ? { retryAfterSeconds: error.retryAfterSeconds } : {}) };
      const stored = await journal.markFailed(requestId, message, envelope); return this.envelopeFromTerminal(stored, false);
    }
    const message = error instanceof Trading212RequestError ? safeMessage(error.message, UNCERTAIN_MESSAGE) : UNCERTAIN_MESSAGE;
    const envelope: ExecutionEnvelope = { environment: "demo", requestId, replayed: false, outcome: "uncertain", message, ...(error instanceof Trading212RequestError && typeof error.status === "number" ? { status: error.status } : {}), ...(error instanceof Trading212RequestError && typeof error.retryAfterSeconds === "number" ? { retryAfterSeconds: error.retryAfterSeconds } : {}) };
    const stored = await journal.update(requestId, { phase: "uncertain", message, result: envelope }); return this.envelopeFromTerminal(stored, false);
  }

  private async recordUnusableOrder(journal: ExecutionJournal, requestId: string): Promise<ExecutionEnvelope> { const envelope: ExecutionEnvelope = { environment: "demo", requestId, replayed: false, outcome: "uncertain", message: UNUSABLE_ORDER_MESSAGE }; const stored = await journal.update(requestId, { phase: "uncertain", message: UNUSABLE_ORDER_MESSAGE, result: envelope }); return this.envelopeFromTerminal(stored, false); }
  private async recordCancelledWithoutReplacement(journal: ExecutionJournal, intent: ModifyOrderIntent, error: Trading212RequestError): Promise<ExecutionEnvelope> { const message = safeMessage(error.message); const envelope: ExecutionEnvelope = { environment: "demo", requestId: intent.requestId, replayed: false, outcome: "cancelled_without_replacement", message, cancelledOrderId: intent.orderId, ...(typeof error.status === "number" ? { status: error.status } : {}) }; const stored = await journal.markFailed(intent.requestId, message, envelope); return this.envelopeFromTerminal(stored, false, intent); }
  private async recordModifyUncertain(journal: ExecutionJournal, intent: ModifyOrderIntent, cause: unknown, cancellationConfirmed = true): Promise<ExecutionEnvelope> { const message = typeof cause === "string" ? cause : cause === "unavailable" ? CANCELLATION_STATE_MESSAGE : cause === "unconfirmed" ? CANCELLATION_UNCONFIRMED_MESSAGE : cause instanceof Error ? safeMessage(cause.message, UNCERTAIN_MESSAGE) : UNCERTAIN_MESSAGE; const envelope: ExecutionEnvelope = { environment: "demo", requestId: intent.requestId, replayed: false, outcome: "uncertain", message, ...(cancellationConfirmed ? { cancelledOrderId: intent.orderId } : {}) }; const stored = await journal.update(intent.requestId, { phase: "uncertain", message, result: envelope }); return this.envelopeFromTerminal(stored, false, intent); }

  private async confirmCancellation(orderId: number): Promise<"confirmed" | "unsafe" | "unconfirmed" | "unavailable"> {
    let unavailable = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.wait(5_000);
        const open = await this.client.getOpenOrders();
        if (!Array.isArray(open)) { unavailable = true; continue; }
        if (open.some((item) => isRecord(item) && item.id === orderId)) continue;
        await this.wait(10_000);
        const history = await this.client.getOrderHistory({ limit: 50 });
        const state = historicalOrderState(history, orderId);
        if (state === "confirmed" || state === "unsafe") return state;
        unavailable = true;
      } catch { unavailable = true; }
    }
    return unavailable ? "unavailable" : "unconfirmed";
  }

  private sendReplacement(replacement: ReplacementOrder): Promise<OrderRecord> {
    switch (replacement.orderType) {
      case "market": return this.client.placeMarketOrder({ ticker: replacement.ticker, quantity: replacement.quantity, extendedHours: replacement.extendedHours });
      case "limit": return this.client.placeLimitOrder({ ticker: replacement.ticker, quantity: replacement.quantity, limitPrice: replacement.limitPrice, timeValidity: replacement.timeValidity });
      case "stop": return this.client.placeStopOrder({ ticker: replacement.ticker, quantity: replacement.quantity, stopPrice: replacement.stopPrice, timeValidity: replacement.timeValidity });
      case "stop_limit": return this.client.placeStopLimitOrder({ ticker: replacement.ticker, quantity: replacement.quantity, stopPrice: replacement.stopPrice, limitPrice: replacement.limitPrice, timeValidity: replacement.timeValidity });
    }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> { const result = this.queue.then(operation); this.queue = result.then(() => undefined, () => undefined); return result; }
}

function assertPositiveInteger(value: number): void { if (!Number.isSafeInteger(value) || value < 1) throw new Error("order ID must be a positive integer"); }
function assertCancellableOrder(order: OrderRecord, orderId: number): void { if (!isRecord(order) || order.id !== orderId || typeof order.status !== "string" || typeof order.filledQuantity !== "number" || order.filledQuantity !== 0 || !CANCELLABLE_STATUSES.has(order.status)) throw new Error("order is not cancellable"); }
function assertModifyIntent(intent: ModifyOrderIntent): void { if (!isRecord(intent) || typeof intent.requestId !== "string" || !intent.requestId || !isRecord(intent.replacement)) throw new Error("modify order intent is invalid"); assertPositiveInteger(intent.orderId); }
function placementFromReplacement(intent: ModifyOrderIntent): PlacementIntent { const replacement = intent.replacement as ReplacementOrder; return { ...replacement, orderType: replacement.orderType }; }
function projectPlacementOrder(order: OrderRecord, input: PlacementInput): Record<string, unknown> | null { if (!isRecord(order)) return null; const id = order.id; const ticker = order.ticker ?? input.ticker; const quantity = order.quantity ?? input.quantity; if (!Number.isSafeInteger(id) || typeof ticker !== "string" || typeof quantity !== "number" || !Number.isFinite(quantity)) return null; return { id, ticker, quantity, ...(typeof order.filledQuantity === "number" ? { filledQuantity: order.filledQuantity } : {}), ...(typeof order.side === "string" ? { side: order.side } : {}) }; }
function historicalOrderState(value: unknown, orderId: number): "confirmed" | "unsafe" | "missing" | "malformed" { if (!isRecord(value) || !Array.isArray(value.items)) return "malformed"; const order = value.items.find((item) => isRecord(item) && item.id === orderId); if (!order || !isRecord(order)) return "missing"; if (order.status === "CANCELLED" && order.filledQuantity === 0) return "confirmed"; if (typeof order.filledQuantity === "number" && order.filledQuantity > 0) return "unsafe"; return "missing"; }
function sanitizeEnvelope(value: Record<string, unknown>): ExecutionEnvelope { if (value.environment !== "demo" || typeof value.requestId !== "string" || typeof value.replayed !== "boolean" || typeof value.outcome !== "string") throw new Error("execution journal result is corrupt"); return value as unknown as ExecutionEnvelope; }
const SAFE_MESSAGES = new Set([INCOMPLETE_MESSAGE, UNCERTAIN_MESSAGE, FAILED_MESSAGE, UNUSABLE_ORDER_MESSAGE, CANCELLATION_UNCONFIRMED_MESSAGE, CANCELLATION_STATE_MESSAGE, "Trading 212 rejected the request (400)", "Trading 212 authentication failed (401)", "Trading 212 permission denied (403)", "Trading 212 order not found (404)", "Trading 212 request timed out (408)", "Trading 212 rate limit exceeded (429)", "Trading 212 request failed before receiving a response", "Trading 212 response could not be processed"]);
function safeMessage(value: string, fallback = FAILED_MESSAGE): string { return SAFE_MESSAGES.has(value) ? value : fallback; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
