# Contributing

Thanks for contributing.

## Development

Install dependencies, run the test suite, and build before submitting changes:

```bash
npm install
npm test
npm run build
```

## Safety-sensitive changes

Changes that affect broker routing, order construction, execution-policy gates, idempotency, reconciliation, or exposure controls must include focused automated tests.

Preserve these invariants:

1. Broker requests must remain restricted to the Trading 212 demo API.
2. Invalid or incomplete execution configuration must fail closed.
3. Mutations must use stable request IDs and must not blindly retry ambiguous dispatch results.
4. Public repository content must not contain credentials, private account data, or runtime state.

Please keep pull requests focused and explain the safety property being preserved when changing execution behavior.
