# Development Notes

## Project evolution

The project has gone through a few distinct stages rather than being designed as a complete execution system from the start.

### Stage 1 — Broker API access

The first implementation focused on making Trading 212 demo account data and basic broker operations accessible through MCP in a structured way. The emphasis was on reliable request handling, typed inputs and useful read tools.

### Stage 2 — Separating capability from authority

Once order mutations were introduced, the design shifted from simply exposing endpoints to controlling what the MCP layer was actually allowed to request. Read-only functionality and mutation functionality were separated, and execution became dependent on explicit policy checks.

### Stage 3 — Bounding execution

The next iteration added concrete limits around instruments, quantities, exposure and mutation budgets. The purpose was to ensure that a valid API call was not automatically considered a valid trading operation.

### Stage 4 — Handling retries and ambiguous states

Network timeouts and process restarts create a different class of failure: the caller may not know whether the broker accepted a request. Persistent execution records and request identity were added so that retries and uncertain states could be handled deliberately rather than relying on transient process memory.

### Stage 5 — Public reference implementation

The public repository is a cleaned, reusable subset of the broader development work. Private strategy material, account-specific configuration and operational notes are intentionally excluded. The objective is to leave the reusable engineering patterns visible: MCP tool design, policy enforcement, execution journaling and a hard demo-environment boundary.

## Current priorities

The next areas of development are automated regression coverage, adversarial testing of policy boundaries, clearer execution observability and making the project easier for other developers to run and extend safely.
