export const DEMO_BASE_URL = "https://demo.trading212.com/api/v0" as const;

export type Trading212Config = {
  apiKey: string;
  apiSecret: string;
  baseUrl: typeof DEMO_BASE_URL;
};

export type EnabledExecutionPolicy = {
  enabled: true;
  allowedTickers: Set<string>;
  companyByTicker: Map<string, string>;
  maxQuoteToAccountRates: Map<string, number>;
  expectedAccountCurrency: string;
  maxAbsQuantity: number;
  maxDailyMutations: number;
  maxOpenOrders: number;
  stateDir: string;
};

export type ExecutionPolicy =
  | EnabledExecutionPolicy
  | { enabled: false; reason: string };

export function assertDemoBaseUrl(value: string): asserts value is typeof DEMO_BASE_URL {
  if (value !== DEMO_BASE_URL) {
    throw new Error("Trading 212 execution is restricted to the demo API");
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): Trading212Config {
  if (!env.TRADING212_API_KEY) {
    throw new Error("Missing TRADING212_API_KEY");
  }
  if (!env.TRADING212_API_SECRET) {
    throw new Error("Missing TRADING212_API_SECRET");
  }
  assertDemoBaseUrl(DEMO_BASE_URL);
  return {
    apiKey: env.TRADING212_API_KEY,
    apiSecret: env.TRADING212_API_SECRET,
    baseUrl: DEMO_BASE_URL,
  };
}

function missing(name: string): { enabled: false; reason: string } {
  return { enabled: false, reason: `Missing ${name}` };
}

function invalid(reason: string): { enabled: false; reason: string } {
  return { enabled: false, reason };
}

function positiveNumber(
  env: NodeJS.ProcessEnv,
  name: string,
): number | { enabled: false; reason: string } {
  const value = env[name];
  if (value === undefined) return missing(name);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return invalid(`${name} must be positive`);
  return parsed;
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
): number | { enabled: false; reason: string } {
  const value = env[name];
  if (value === undefined) return missing(name);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return invalid(`${name} must be a positive integer`);
  }
  return parsed;
}

function mapping(
  env: NodeJS.ProcessEnv,
  name: string,
  validateKey: (key: string) => boolean,
  validateValue: (value: string) => boolean,
): Map<string, string> | { enabled: false; reason: string } {
  const raw = env[name];
  if (raw === undefined) return missing(name);

  const result = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const parts = entry.split("=").map((part) => part.trim());
    if (
      parts.length !== 2 ||
      !validateKey(parts[0] ?? "") ||
      !validateValue(parts[1] ?? "") ||
      result.has(parts[0]!)
    ) {
      return invalid(`${name} is invalid`);
    }
    result.set(parts[0]!, parts[1]!);
  }

  return result.size > 0 ? result : invalid(`${name} is invalid`);
}

export function loadExecutionPolicy(env: NodeJS.ProcessEnv): ExecutionPolicy {
  if (env.TRADING212_EXECUTION_ENABLED !== "true") {
    return { enabled: false, reason: "Trading 212 paper execution is disabled" };
  }

  const tickerValue = env.TRADING212_ALLOWED_TICKERS;
  if (tickerValue === undefined) return missing("TRADING212_ALLOWED_TICKERS");
  const allowedTickers = new Set(
    tickerValue
      .split(",")
      .map((ticker) => ticker.trim())
      .filter(Boolean),
  );
  if (allowedTickers.size === 0) {
    return invalid("TRADING212_ALLOWED_TICKERS must not be empty");
  }

  const companyByTicker = mapping(
    env,
    "TRADING212_COMPANY_BY_TICKER",
    (ticker) => ticker.length > 0,
    (company) => company.length > 0,
  );
  if (!(companyByTicker instanceof Map)) return companyByTicker;
  for (const ticker of allowedTickers) {
    if (!companyByTicker.has(ticker)) return invalid(`Missing company mapping for ${ticker}`);
  }

  const quoteRates = mapping(
    env,
    "TRADING212_MAX_QUOTE_TO_ACCOUNT_RATES",
    (currency) => /^[A-Z]{3}$/.test(currency),
    (rate) => Number.isFinite(Number(rate)) && Number(rate) > 0,
  );
  if (!(quoteRates instanceof Map)) return quoteRates;
  const maxQuoteToAccountRates = new Map(
    [...quoteRates].map(([currency, rate]) => [currency, Number(rate)]),
  );

  const expectedAccountCurrency = env.TRADING212_EXPECTED_ACCOUNT_CURRENCY;
  if (expectedAccountCurrency === undefined) return missing("TRADING212_EXPECTED_ACCOUNT_CURRENCY");
  if (!/^[A-Z]{3}$/.test(expectedAccountCurrency)) {
    return invalid("TRADING212_EXPECTED_ACCOUNT_CURRENCY is invalid");
  }

  const maxAbsQuantity = positiveNumber(env, "TRADING212_MAX_ABS_QUANTITY");
  if (typeof maxAbsQuantity !== "number") return maxAbsQuantity;
  const maxDailyMutations = positiveInteger(env, "TRADING212_MAX_DAILY_MUTATIONS");
  if (typeof maxDailyMutations !== "number") return maxDailyMutations;
  const maxOpenOrders = positiveInteger(env, "TRADING212_MAX_OPEN_ORDERS");
  if (typeof maxOpenOrders !== "number") return maxOpenOrders;

  const stateDir = env.TRADING212_EXECUTION_STATE_DIR?.trim();
  if (stateDir === undefined) return missing("TRADING212_EXECUTION_STATE_DIR");
  if (!stateDir) return invalid("TRADING212_EXECUTION_STATE_DIR must not be empty");

  return {
    enabled: true,
    allowedTickers,
    companyByTicker,
    maxQuoteToAccountRates,
    expectedAccountCurrency,
    maxAbsQuantity,
    maxDailyMutations,
    maxOpenOrders,
    stateDir,
  };
}
