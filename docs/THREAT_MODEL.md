# Threat Model

This document describes the main failure modes considered by the public demo execution layer.

## Assets

- Broker credentials supplied at runtime
- Account and portfolio data returned by the broker API
- Order instructions and their intended parameters
- Execution state and journal records

## Trust Boundaries

The main boundaries are:

1. MCP caller → tool input validation
2. Tool handler → execution policy
3. Execution policy → broker client
4. Broker dispatch → execution-state confirmation
5. Runtime credentials → external process configuration

## Key Threats

### Accidental live execution

A configuration or endpoint mistake could route an otherwise valid order toward a live environment. The public implementation therefore keeps the broker base URL fixed to the demo service rather than accepting an arbitrary endpoint from runtime configuration.

### Policy bypass

An unsafe mutation could attempt to reach the broker without passing the common execution checks. Mutation tools are routed through the guarded executor and policy layer rather than calling the HTTP client directly.

### Excessive exposure

A valid order can still be unsafe when its size is disproportionate to the available account. Quantity and exposure checks place explicit bounds on execution before dispatch.

### Duplicate execution after retry

A caller may retry after a timeout even though the first request was already dispatched. The persistent journal provides request identity and execution phases so retries can be detected and handled explicitly.

### Uncertain broker state

Network failures do not necessarily mean that an order was not accepted. The executor distinguishes failure from uncertainty and avoids silently treating an unknown state as a clean rejection.

### Credential leakage

Secrets are expected to be supplied through environment variables or the runtime secret store rather than committed to the repository. Public configuration examples contain placeholders only.

## Security Posture

The project is deliberately conservative: when required execution information cannot be established safely, the preferred outcome is to reject the operation rather than infer missing state. The threat model will evolve as new tools and execution features are added.
