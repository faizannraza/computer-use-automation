# Computer-Use Automation System

A small but real end-to-end system that gives AI agents *hands* inside legacy back-office applications that have no API:

1. An **LLM-driven agent** takes a natural-language goal and operates a live UI (observe → decide → act).
2. The successful run is compiled into a **typed, versioned capability artifact** — a reviewable contract with typed inputs and outputs.
3. That artifact is **replayed deterministically** — no LLM in the loop — with a result contract that distinguishes expected business outcomes ("no such member") from recoverable conditions (session timeout) and hard failures.
4. Every action passes through a single **policy gate** (allowlist, risk classes, redaction), and when the system can't safely proceed it **escalates to a human**, who takes control of the same live session and hands it back.

> **The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the AI agent invokes it in production.**

The target application is a self-contained, intentionally *legacy-hostile* mock credit-union back-office (framesets, table layouts, no test IDs) with deterministic fault injection — so every scenario in `/evidence/` is reproducible on your machine.

**Status: under construction — this README will carry full setup + demo-path instructions as the system lands.**

## Layout

```
apps/mock-cu/     the target application (mock credit-union back office + fault injection)
src/              the automation system (surface, policy, discovery, replay, HITL, evidence)
capabilities/     saved capability artifacts
policies/         policy configuration (allowlists, risk rules)
tenants/          tenant overlay examples
evidence/         discovery + replay run evidence (a deliverable)
REPORT.md         design write-up
```
