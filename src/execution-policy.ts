import type { EnabledExecutionPolicy, ExecutionPolicy } from "./config.js";
import type { ExecutionJournal } from "./execution-journal.js";
import type { PlacementIntent } from "./order-types.js";

export type PolicyReader = {
  getAccountSummary(): Promise<unknown>;
  getPositions(): Promise<unknown>;
  getOpenOrders(): Promise<unknown>;
  getInstruments(): Promise<unknown>;
};

const INSTRUMENT_METADATA_CACHE_TTL_MS = 10 * 60 * 1000;
const PROBE_NAV_FRACTION = 0.15;
const NORMAL_COMPANY_NAV_FRACTION = 0.25;
const MAX_COMPANIES = 2;

export function orderReferencePrice(intent: PlacementIntent): number {
  switch (intent.orderType) {
    case "market": return intent.referencePrice;
    case "stop": return Math.max(intent.referencePrice, intent.stopPrice);
    case "limit": return intent.limitPrice;
    case "stop_limit": return Math.max(intent.stopPrice, intent.limitPrice);
  }
}

export function numericTickerQuantity(items: Array<Record<string, unknown>>, ticker: string): number {
  return items.reduce((total, item) => {
    const quantity = item.quantity;
    return item.ticker === ticker && typeof quantity === "number" && Number.isFinite(quantity)
      ? total + quantity : total;
  }, 0);
}

export function pendingSellQuantity(items: Array<Record<string, unknown>>, ticker: string): number {
  return items.reduce((total, item) => {
    const quantity = item.quantity;
    return item.ticker === ticker && item.side === "SELL" && typeof quantity === "number" && Number.isFinite(quantity)
      ? total + Math.abs(quantity) : total;
  }, 0);
}

export class ExecutionPolicyGate {
  private cachedInstruments?: { value: Array<Record<string, unknown>>; expiresAt: number };
  private instrumentsInFlight: Promise<Array<Record<string, unknown>>> | undefined;

  constructor(
    private readonly policy: ExecutionPolicy,
    private readonly reader: PolicyReader,
    private readonly journal?: Pick<ExecutionJournal, "countMutations">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  requireEnabled(): EnabledExecutionPolicy {
    if (!this.policy.enabled) throw new Error(this.policy.reason);
    return this.policy;
  }

  async validateMutationBudget(requestedMutations: number): Promise<void> {
    const policy = this.requireEnabled();
    if (!this.journal) throw new Error("Trading 212 execution journal is unavailable");
    if (!Number.isSafeInteger(requestedMutations) || requestedMutations <= 0) {
      throw new Error("requested mutation count must be a positive safe integer");
    }
    const utcDate = this.now().toISOString().slice(0, 10);
    const used = await this.journal.countMutations(utcDate);
    if (!Number.isSafeInteger(used) || used < 0 || used + requestedMutations > policy.maxDailyMutations) {
      throw new Error("daily mutation limit would be exceeded");
    }
  }

  async validatePlacement(intent: PlacementIntent, requestedMutations: number): Promise<void> {
    const policy = this.requireEnabled();
    if (!policy.allowedTickers.has(intent.ticker)) throw new Error("ticker is not allowed");
    if (!Number.isFinite(intent.quantity) || intent.quantity === 0) throw new Error("quantity must be finite and non-zero");
    if (Math.abs(intent.quantity) > policy.maxAbsQuantity) throw new Error("quantity exceeds configured limit");
    if (!hasPositivePrices(intent)) throw new Error("price must be positive");
    if (intent.quantity > 0 && intent.orderType === "market") throw new Error("market buys are disabled by Layer 7");
    if (intent.quantity > 0 && intent.orderType === "stop") throw new Error("stop buys are disabled by Layer 7");

    const quoteValue = Math.abs(intent.quantity) * orderReferencePrice(intent);
    if (!Number.isFinite(quoteValue)) throw new Error("estimated order value must be finite");

    await this.validateMutationBudget(requestedMutations);
    const [openOrdersRaw, instruments, positionsRaw, accountRaw] = await Promise.all([
      this.reader.getOpenOrders(),
      this.getInstruments(),
      this.reader.getPositions(),
      intent.quantity > 0 ? this.reader.getAccountSummary() : Promise.resolve(undefined),
    ]);
    const instrumentByTicker = new Map(instruments.map((instrument) => [instrument.ticker as string, instrument]));
    if (!instrumentByTicker.has(intent.ticker)) throw new Error("ticker was not found in Trading 212 metadata");
    const openOrders = decodeOpenOrders(openOrdersRaw);
    if (openOrders.length + 1 > policy.maxOpenOrders) throw new Error("open-order limit would be exceeded");
    const positions = decodePositions(positionsRaw);

    if (intent.quantity > 0) {
      const account = decodeBuyAccount(accountRaw);
      if (account.currency !== policy.expectedAccountCurrency) throw new Error("account currency does not match configured currency");
      const proposedValue = accountCurrencyValue(quoteValue, intent.ticker, account.currency, instrumentByTicker, policy);
      if (proposedValue > account.availableCash) throw new Error("order exceeds available cash");
      validateLayer7Buy(intent, proposedValue, account.totalValue, account.currency, positions, openOrders, instrumentByTicker, policy);
      return;
    }

    const held = numericTickerQuantity(positions, intent.ticker);
    const pending = pendingSellQuantity(openOrders, intent.ticker);
    const availableHoldings = held - pending;
    if (!Number.isFinite(availableHoldings) || availableHoldings < 0 || Math.abs(intent.quantity) > availableHoldings) {
      throw new Error("sell quantity exceeds available holdings");
    }
  }

  private getInstruments(): Promise<Array<Record<string, unknown>>> {
    const timestamp = this.now().getTime();
    if (this.cachedInstruments && timestamp < this.cachedInstruments.expiresAt) return Promise.resolve(this.cachedInstruments.value);
    if (this.instrumentsInFlight) return this.instrumentsInFlight;
    const request = this.reader.getInstruments().then(decodeInstruments).then((instruments) => {
      this.cachedInstruments = { value: instruments, expiresAt: this.now().getTime() + INSTRUMENT_METADATA_CACHE_TTL_MS };
      return instruments;
    });
    this.instrumentsInFlight = request;
    const clear = () => { if (this.instrumentsInFlight === request) this.instrumentsInFlight = undefined; };
    void request.then(clear, clear);
    return request;
  }
}

function hasPositivePrices(intent: PlacementIntent): boolean {
  switch (intent.orderType) {
    case "market": return isPositive(intent.referencePrice);
    case "limit": return isPositive(intent.limitPrice);
    case "stop": return isPositive(intent.stopPrice) && isPositive(intent.referencePrice);
    case "stop_limit": return isPositive(intent.stopPrice) && isPositive(intent.limitPrice);
  }
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeInstruments(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || !value.every((item) => hasTicker(item))) throw new Error("instrument metadata is unavailable");
  return value;
}

function decodeOpenOrders(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || !value.every((item) => hasTicker(item) && (item.side === "BUY" || item.side === "SELL") && typeof item.quantity === "number" && Number.isFinite(item.quantity))) {
    throw new Error("open orders are unavailable");
  }
  return value;
}

function decodePositions(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || !value.every((item) => hasTicker(item) && typeof item.quantity === "number" && Number.isFinite(item.quantity))) {
    throw new Error("positions are unavailable");
  }
  return value;
}

function decodeBuyAccount(value: unknown): { availableCash: number; totalValue: number; currency: string } {
  const availableCash = isRecord(value) && isRecord(value.cash) ? value.cash.availableToTrade : undefined;
  if (typeof availableCash !== "number" || !Number.isFinite(availableCash) || availableCash < 0) throw new Error("available cash is unavailable");
  const totalValue = isRecord(value) ? value.totalValue : undefined;
  if (typeof totalValue !== "number" || !Number.isFinite(totalValue) || totalValue <= 0) throw new Error("account NAV is unavailable");
  const currency = isRecord(value) ? value.currency : undefined;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new Error("account currency is unavailable");
  return { availableCash, totalValue, currency };
}

function validateLayer7Buy(
  intent: PlacementIntent,
  proposedValue: number,
  totalValue: number,
  accountCurrency: string,
  positions: Array<Record<string, unknown>>,
  openOrders: Array<Record<string, unknown>>,
  instrumentByTicker: Map<string, Record<string, unknown>>,
  policy: EnabledExecutionPolicy,
): void {
  const heldValues = heldCompanyValues(positions, accountCurrency, instrumentByTicker, policy);
  const pendingValues = pendingBuyValues(openOrders, accountCurrency, instrumentByTicker, policy);
  const companies = new Set([...heldValues.keys(), ...pendingValues.keys()]);
  const company = companyIdentity(intent.ticker, policy);
  if (companies.size > MAX_COMPANIES || (!companies.has(company) && companies.size >= MAX_COMPANIES)) throw new Error("maximum two companies would be exceeded");
  const heldValue = heldValues.get(company) ?? 0;
  if (intent.probeConfirmed && heldValue === 0) throw new Error("confirmed expansion requires an existing probe position");
  const aggregateValue = heldValue + (pendingValues.get(company) ?? 0) + proposedValue;
  const cap = totalValue * (intent.probeConfirmed ? NORMAL_COMPANY_NAV_FRACTION : PROBE_NAV_FRACTION);
  if (aggregateValue > cap) throw new Error(intent.probeConfirmed ? "normal company exposure would exceed 25% NAV" : "probe company exposure would exceed 15% NAV");
}

function heldCompanyValues(items: Array<Record<string, unknown>>, accountCurrency: string, instrumentByTicker: Map<string, Record<string, unknown>>, policy: EnabledExecutionPolicy): Map<string, number> {
  const values = new Map<string, number>();
  for (const item of items) {
    const quantity = item.quantity;
    const currentPrice = item.currentPrice;
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0 || typeof currentPrice !== "number" || !Number.isFinite(currentPrice) || currentPrice <= 0) throw new Error("position exposure is unavailable");
    const ticker = item.ticker as string;
    const value = accountCurrencyValue(quantity * currentPrice, ticker, accountCurrency, instrumentByTicker, policy);
    const company = companyIdentity(ticker, policy);
    values.set(company, (values.get(company) ?? 0) + value);
  }
  return values;
}

function pendingBuyValues(items: Array<Record<string, unknown>>, accountCurrency: string, instrumentByTicker: Map<string, Record<string, unknown>>, policy: EnabledExecutionPolicy): Map<string, number> {
  const values = new Map<string, number>();
  for (const item of items) {
    if (item.side !== "BUY") continue;
    const quantity = item.quantity;
    const price = pendingBuyPrice(item);
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0 || price === undefined) throw new Error("pending buy exposure is unavailable");
    const ticker = item.ticker as string;
    const value = accountCurrencyValue(quantity * price, ticker, accountCurrency, instrumentByTicker, policy);
    const company = companyIdentity(ticker, policy);
    values.set(company, (values.get(company) ?? 0) + value);
  }
  return values;
}

function pendingBuyPrice(item: Record<string, unknown>): number | undefined {
  const prices = [item.limitPrice, item.stopPrice].filter(isPositive);
  return prices.length === 0 ? undefined : Math.max(...prices);
}

function companyIdentity(ticker: string, policy: EnabledExecutionPolicy): string {
  const company = policy.companyByTicker.get(ticker);
  if (!company) throw new Error("company identity is unavailable");
  return company;
}

function accountCurrencyValue(quoteValue: number, ticker: string, accountCurrency: string, instrumentByTicker: Map<string, Record<string, unknown>>, policy: EnabledExecutionPolicy): number {
  const currencyCode = instrumentByTicker.get(ticker)?.currencyCode;
  if (typeof currencyCode !== "string" || !/^[A-Z]{3}$/.test(currencyCode)) throw new Error("instrument currency is unavailable");
  const rate = currencyCode === accountCurrency ? 1 : policy.maxQuoteToAccountRates.get(currencyCode);
  if (rate === undefined) throw new Error("currency conversion is unavailable");
  const value = quoteValue * rate;
  if (!Number.isFinite(value)) throw new Error("currency conversion is unavailable");
  return value;
}

function hasTicker(value: unknown): value is Record<string, unknown> & { ticker: string } {
  return isRecord(value) && typeof value.ticker === "string" && value.ticker.length > 0;
}
