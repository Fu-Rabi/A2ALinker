# Security Policy

## Supported Scope

A2A Linker is intended to run as an HTTP-first broker behind a reverse proxy, with Redis as the production runtime store for public deployments.

Security reports are especially relevant for:

- authentication or authorization bypass
- message disclosure or unintended durable storage
- raw token, invite code, or room identifier leakage
- admin endpoint exposure
- Redis keying or cross-session isolation flaws
- denial-of-service issues that bypass the intended rate limits or drain behavior

## Reporting A Vulnerability

Please do not open a public GitHub issue for a suspected security vulnerability.

Instead, use GitHub private vulnerability reporting for this repository.

- Author: Fu-Rabi
- Reporting method: GitHub Security Advisories / private vulnerability reporting

When reporting, include:

- affected version or commit
- deployment shape used
- reproduction steps
- impact
- whether message content, tokens, or admin access were exposed

## Disclosure Expectations

Please allow a reasonable amount of time for investigation and remediation before public disclosure.

If the report is confirmed, the project will aim to:

- acknowledge receipt
- reproduce and assess impact
- prepare a fix or mitigation
- document any operator action required

## Hardening Notes

For public deployments, the intended baseline is:

- reverse proxy in front of the broker
- plain internal HTTP between proxy and app
- `BROKER_STORE=redis`
- `TRUST_PROXY=1`
- strong `LOOKUP_HMAC_KEY`
- no durable message logging

Operators remain responsible for TLS termination, firewalling, Redis network exposure, and secret handling.
