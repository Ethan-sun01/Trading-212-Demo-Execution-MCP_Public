# Architecture Notes

## From API Wrapper to Guarded Execution Layer

The project began as a small experiment in exposing the Trading 212 demo API through MCP. The initial problem was straightforward: make account, position, order and instrument data available as structured tools.

As the interface grew, the more important problem became the boundary around execution. An MCP server can make broker operations easy for an agent to call, but convenience is not the same thing as safety. The design therefore evolved toward a layered execution path in which read operations remain broadly useful while order mutations pass through explicit policy checks.

## Current Design Principles

### 1. Demo environment is a hard boundary

The broker client targets the Trading 212 demo API directly. The public project is intended for development, integration testing and workflow experimentation rather than live trading.

### 2. Read and mutation paths are separate

Account and market inspection tools use the read path. Order placement, cancellation and modification are handled by a separate guarded execution path so that adding a new read capability does not implicitly expand execution authority.

### 3. Policy before dispatch

A mutation is checked against execution policy before it reaches the broker client. The policy layer validates the execution switch, instrument allowlist, quantity limits, exposure constraints, account state and other execution conditions. Invalid or ambiguous requests fail closed.

### 4. Execution is stateful

The execution journal records request identity and execution phases so that retries can be distinguished from genuinely new operations. This is intended to reduce duplicate execution when an upstream caller retries after a timeout or uncertain network state.

### 5. Failure states are explicit

The executor treats dispatch, confirmation and uncertainty as different states rather than assuming that an HTTP response alone tells the whole story. Cancellation and replacement flows are handled through the same guarded execution path.

## Why the Layers Matter

The individual checks are useful, but the main design goal is the composition of the checks. Endpoint isolation, policy validation, exposure controls, mutation budgets, idempotency and execution-state tracking provide independent barriers. A future change should be able to add capability without quietly removing those barriers.

## Development Direction

The public repository is intentionally narrower than the original development environment. Private strategy research, account-specific configuration and operational material are kept outside this repository. The public code focuses on the reusable MCP, broker-client and execution-safety components.

Future work is expected to concentrate on stronger automated testing, adversarial execution-path testing, clearer observability and easier local validation for contributors.
