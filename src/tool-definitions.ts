import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const toolNames = [
  "get_account_summary", "get_cash", "get_positions", "get_position", "get_open_orders", "get_order", "get_order_history", "get_transactions", "search_instruments", "get_exchanges", "get_broker_snapshot",
  "place_market_order", "place_limit_order", "place_stop_order", "place_stop_limit_order", "cancel_order", "modify_order",
] as const;
export type ToolName = (typeof toolNames)[number];
export const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations;
export const mutationAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations;
type ToolDefinition = { name: ToolName; description: string; inputSchema: z.ZodObject; annotations: ToolAnnotations };

const emptyInput = z.object({});
const requestId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const ticker = z.string().trim().min(1);
const quantity = z.number().finite().refine((value) => value !== 0, "quantity must be non-zero");
const price = z.number().finite().positive();
const timeValidity = z.enum(["DAY", "GOOD_TILL_CANCEL"]);
const orderId = z.number().int().positive();
const probeConfirmed = z.boolean().optional().default(false);
const marketInput = z.object({ requestId, ticker, quantity, referencePrice: price, extendedHours: z.boolean().optional().default(false), probeConfirmed });
const limitInput = z.object({ requestId, ticker, quantity, limitPrice: price, timeValidity, probeConfirmed });
const stopInput = z.object({ requestId, ticker, quantity, stopPrice: price, referencePrice: price, timeValidity, probeConfirmed });
const stopLimitInput = z.object({ requestId, ticker, quantity, stopPrice: price, limitPrice: price, timeValidity, probeConfirmed });
const replacement = z.discriminatedUnion("orderType", [
  marketInput.omit({ requestId: true }).extend({ orderType: z.literal("market") }),
  limitInput.omit({ requestId: true }).extend({ orderType: z.literal("limit") }),
  stopInput.omit({ requestId: true }).extend({ orderType: z.literal("stop") }),
  stopLimitInput.omit({ requestId: true }).extend({ orderType: z.literal("stop_limit") }),
]);

export const toolDefinitions: readonly ToolDefinition[] = [
  { name: "get_account_summary", description: "Read account totals and currency from the Trading 212 demo account.", inputSchema: emptyInput, annotations: readOnlyAnnotations },
  { name: "get_cash", description: "Read the compact cash breakdown from the Trading 212 demo account.", inputSchema: emptyInput, annotations: readOnlyAnnotations },
  { name: "get_positions", description: "Read all current positions from the Trading 212 demo account.", inputSchema: emptyInput, annotations: readOnlyAnnotations },
  { name: "get_position", description: "Read one current position by exact ticker from the Trading 212 demo account.", inputSchema: z.object({ ticker }), annotations: readOnlyAnnotations },
  { name: "get_open_orders", description: "Read all pending orders from the Trading 212 demo account.", inputSchema: emptyInput, annotations: readOnlyAnnotations },
  { name: "get_order", description: "Read one current order by ID from the Trading 212 demo account.", inputSchema: z.object({ id: orderId }), annotations: readOnlyAnnotations },
  { name: "get_order_history", description: "Read a bounded page of historical orders from the Trading 212 demo account.", inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional(), cursor: z.number().int().optional(), ticker: ticker.optional() }), annotations: readOnlyAnnotations },
  { name: "get_transactions", description: "Read a bounded page of transactions from the Trading 212 demo account.", inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional(), cursor: z.string().min(1).optional(), time: z.iso.datetime().optional() }), annotations: readOnlyAnnotations },
  { name: "search_instruments", description: "Search instrument metadata by ticker or name in the Trading 212 demo account.", inputSchema: z.object({ search: z.string().trim().min(1), limit: z.number().int().min(1).max(25).optional() }), annotations: readOnlyAnnotations },
  { name: "get_exchanges", description: "Read exchange metadata from the Trading 212 demo account.", inputSchema: emptyInput, annotations: readOnlyAnnotations },
  { name: "get_broker_snapshot", description: "Read a reconciliation snapshot from the Trading 212 demo account.", inputSchema: emptyInput, annotations: readOnlyAnnotations },
  { name: "place_market_order", description: "Place a market order in the Trading 212 demo account.", inputSchema: marketInput, annotations: mutationAnnotations },
  { name: "place_limit_order", description: "Place a limit order in the Trading 212 demo account.", inputSchema: limitInput, annotations: mutationAnnotations },
  { name: "place_stop_order", description: "Place a stop order in the Trading 212 demo account.", inputSchema: stopInput, annotations: mutationAnnotations },
  { name: "place_stop_limit_order", description: "Place a stop-limit order in the Trading 212 demo account.", inputSchema: stopLimitInput, annotations: mutationAnnotations },
  { name: "cancel_order", description: "Request cancellation of a pending order in the Trading 212 demo account.", inputSchema: z.object({ requestId, orderId }), annotations: mutationAnnotations },
  { name: "modify_order", description: "Non-atomic cancel-and-replace for a pending order in the Trading 212 demo account.", inputSchema: z.object({ requestId, orderId, replacement }), annotations: mutationAnnotations },
];
