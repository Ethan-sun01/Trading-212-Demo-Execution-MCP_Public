import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OrderExecutor } from "./order-executor.js";
import type { CancelOrderIntent, LimitOrderIntent, MarketOrderIntent, ModifyOrderIntent, StopLimitOrderIntent, StopOrderIntent } from "./order-types.js";
import { toolDefinitions, type ToolName } from "./tool-definitions.js";

export type Trading212Reader = {
  getAccountSummary(): Promise<unknown>;
  getCash(): Promise<unknown>;
  getPositions(): Promise<unknown>;
  getPosition(ticker: string): Promise<unknown>;
  getOpenOrders(): Promise<unknown>;
  getOrder(id: number): Promise<unknown>;
  getOrderHistory(options: { limit?: number; cursor?: number; ticker?: string }): Promise<unknown>;
  getTransactions(options: { limit?: number; cursor?: string; time?: string }): Promise<unknown>;
  searchInstruments(search: string, limit?: number): Promise<unknown>;
  getExchanges(): Promise<unknown>;
  getBrokerSnapshot(): Promise<unknown>;
};
export type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function success(value: unknown): CallToolResult {
  const structuredContent = { data: value ?? null };
  return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
}
function failure(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : "Trading 212 request failed without an error message";
  return { isError: true, content: [{ type: "text", text: message }] };
}
function safe(operation: () => Promise<unknown>): Promise<CallToolResult> { return operation().then(success, failure); }
function optionalNumber(args: Record<string, unknown>, key: string): number | undefined { return typeof args[key] === "number" ? args[key] : undefined; }
function optionalString(args: Record<string, unknown>, key: string): string | undefined { return typeof args[key] === "string" ? args[key] : undefined; }

export function createToolHandlers(client: Trading212Reader, executor: Pick<OrderExecutor, "placeMarketOrder" | "placeLimitOrder" | "placeStopOrder" | "placeStopLimitOrder" | "cancelOrder" | "modifyOrder">): Record<ToolName, ToolHandler> {
  return {
    get_account_summary: () => safe(() => client.getAccountSummary()),
    get_cash: () => safe(() => client.getCash()),
    get_positions: () => safe(() => client.getPositions()),
    get_position: (args) => safe(() => client.getPosition(String(args.ticker))),
    get_open_orders: () => safe(() => client.getOpenOrders()),
    get_order: (args) => safe(() => client.getOrder(Number(args.id))),
    get_order_history: (args) => safe(() => client.getOrderHistory({ ...(optionalNumber(args, "limit") === undefined ? {} : { limit: optionalNumber(args, "limit") }), ...(optionalNumber(args, "cursor") === undefined ? {} : { cursor: optionalNumber(args, "cursor") }), ...(optionalString(args, "ticker") === undefined ? {} : { ticker: optionalString(args, "ticker") }) })),
    get_transactions: (args) => safe(() => client.getTransactions({ ...(optionalNumber(args, "limit") === undefined ? {} : { limit: optionalNumber(args, "limit") }), ...(optionalString(args, "cursor") === undefined ? {} : { cursor: optionalString(args, "cursor") }), ...(optionalString(args, "time") === undefined ? {} : { time: optionalString(args, "time") }) })),
    search_instruments: (args) => safe(() => optionalNumber(args, "limit") === undefined ? client.searchInstruments(String(args.search)) : client.searchInstruments(String(args.search), optionalNumber(args, "limit"))),
    get_exchanges: () => safe(() => client.getExchanges()),
    get_broker_snapshot: () => safe(() => client.getBrokerSnapshot()),
    place_market_order: (args) => safe(() => executor.placeMarketOrder(args as MarketOrderIntent)),
    place_limit_order: (args) => safe(() => executor.placeLimitOrder(args as LimitOrderIntent)),
    place_stop_order: (args) => safe(() => executor.placeStopOrder(args as StopOrderIntent)),
    place_stop_limit_order: (args) => safe(() => executor.placeStopLimitOrder(args as StopLimitOrderIntent)),
    cancel_order: (args) => safe(() => executor.cancelOrder(args as CancelOrderIntent)),
    modify_order: (args) => safe(() => executor.modifyOrder(args as ModifyOrderIntent)),
  };
}

export function registerTrading212Tools(server: Pick<McpServer, "registerTool">, client: Trading212Reader, executor: Pick<OrderExecutor, "placeMarketOrder" | "placeLimitOrder" | "placeStopOrder" | "placeStopLimitOrder" | "cancelOrder" | "modifyOrder">): void {
  const handlers = createToolHandlers(client, executor);
  for (const definition of toolDefinitions) {
    server.registerTool(definition.name, { description: definition.description, inputSchema: definition.inputSchema, annotations: definition.annotations }, async (args) => handlers[definition.name](args));
  }
}
