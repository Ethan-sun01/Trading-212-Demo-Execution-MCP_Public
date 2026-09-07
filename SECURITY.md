# Security Policy

## Scope

This repository is designed to interact with the Trading 212 **demo/practice** API only. The source code deliberately hard-locks the broker base URL to the demo endpoint.

## Reporting a vulnerability

Please do not disclose API keys, secrets, account identifiers, personal information, or other sensitive material in public issues.

For a suspected security vulnerability, contact the repository maintainer privately through GitHub and provide enough technical detail to reproduce the issue without including credentials or private account data.

## Credential handling

Trading 212 credentials belong outside the repository. Use environment variables or another local secret-management mechanism. Never commit real credentials, `.env` files, account exports, runtime databases, or broker responses containing private information.

## Safety-critical areas

Changes to broker routing, execution-policy validation, request idempotency, mutation handling, order reconciliation, or exposure limits should be treated as security-sensitive and covered by tests.
