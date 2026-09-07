# Trading 212 Demo Execution MCP

A safety-focused Model Context Protocol (MCP) server for interacting with a **Trading 212 Invest practice/demo account** from an MCP client such as the MCP Inspector or an AI coding/runtime environment.

The project exposes read-only account and market-metadata tools plus guarded order tools. **Execution is permanently restricted to Trading 212's demo API in source code; it is not configurable to the live API.**

> **Safety note:** This project can submit orders to a Trading 212 demo/practice account when execution is explicitly enabled and all policy gates pass. It is not a trading strategy and is not financial advice.

## Features

- Trading 212 demo-account API client
- 11 read-only MCP tools
- 6 guarded order-mutation tools
- Zod input validation
- Fail-closed execution policy
- Stable request IDs and idempotency journal
- Bounded quantity, daily-mutation and open-order limits
- Aggregate company-exposure checks for buys
- Explicit handling of uncertain post-dispatch results
- Structured MCP tool annotations for read-only vs destructive operations
- Automated tests and TypeScript build

## Safety boundary

The API base URL is a compile-time constant:

```text
https://demo.trading212.com/api/v0
```

The client asserts this URL before every broker request. There is no environment variable or configuration option that can switch the program to `https://live.trading212.com/api/v0`.

Execution is also disabled unless the execution policy is explicitly enabled and every required policy variable validates successfully. Invalid or incomplete configuration fails closed.

## MCP tools

### Read-only

- `get_account_summary`
- `get_cash`
- `get_positions`
- `get_position`
- `get_open_orders`
- `get_order`
- `get_order_history`
- `get_transactions`
- `search_instruments`
- `get_exchanges`
- `get_broker_snapshot`

### Demo-account mutations

- `place_market_order`
- `place_limit_order`
- `place_stop_order`
- `place_stop_limit_order`
- `cancel_order`
- `modify_order`

Mutation tools are annotated as destructive and idempotent. `modify_order` is intentionally implemented as a non-atomic cancel-and-replace operation and does not pretend a confirmed cancellation can be rolled back if replacement fails.

## Requirements

- Node.js with npm
- A Trading 212 **demo/practice** API key and secret with the required permissions
- An MCP-capable client

## Setup

Install dependencies and build:

```bash
npm install
npm test
npm run build
```

Configure credentials outside the repository:

```text
TRADING212_API_KEY=<practice-key>
TRADING212_API_SECRET=<practice-secret>
```

See `.env.example` for the complete set of supported configuration variables.

**Never commit real credentials.**

## Execution policy

Reads remain available when execution is disabled. Demo execution requires `TRADING212_EXECUTION_ENABLED=true` plus the full policy configuration, including:

- allowed tickers
- ticker/company identity mapping
- conservative quote-to-account conversion ceilings
- expected account currency
- maximum absolute quantity
- maximum daily mutations
- maximum open orders
- persistent execution-state directory

A mutation also requires a stable `requestId`. Reusing the same request ID with identical input replays the journaled result rather than dispatching the broker request again. Reusing it with different input is rejected.

Ambiguous post-dispatch failures are recorded as `uncertain` and are not blindly retried.

## Inspect with MCP Inspector

After building:

```bash
npx @modelcontextprotocol/inspector@latest node dist/src/server.js
```

The server should expose the 17 tools listed above.

## Testing

The default test command is:

```bash
npm test
```

Build verification:

```bash
npm run build
```

The repository includes additional scripts for controlled demo validation and replay. These require deliberate local configuration and should only be used against the Trading 212 practice/demo environment.

## Project structure

```text
src/        MCP server, Trading 212 client, validation and execution policy
scripts/    local smoke/replay/validation helpers
tests/      automated tests
fixtures/   deterministic test fixtures
docs/       public implementation and policy documentation
```

## What this project does not do

This repository does not provide investment advice, portfolio recommendations, market predictions, or a live-broker execution path. Strategy and decision logic are intentionally separated from the broker bridge.

## Contributing

Please read `CONTRIBUTING.md` before opening a pull request. Changes affecting execution safety, broker routing, idempotency, or policy enforcement should include focused tests and a clear explanation of the safety invariant being preserved.

## Security

Please see `SECURITY.md` for responsible disclosure guidance. Do not report credentials, API keys, or other sensitive information in public issues.

## License

MIT. See `LICENSE`.
