# Computer-Use Automation System

A small but real end-to-end system that gives AI agents *hands* inside legacy back-office applications that have no API:

1. An **LLM-driven agent** takes a natural-language goal and operates a live UI (observe → decide → act), with every action passing through a policy gate.
2. The successful run is **compiled — deterministically, no LLM — into a typed, versioned capability artifact**: a reviewable contract with typed inputs, typed outputs, and named business outcomes.
3. That artifact **replays with no model in the loop**, using a semantic locator ladder and per-step checkpoints, and classifies everything it sees: expected business outcomes ("no such member") ≠ recoverable conditions (session timeout) ≠ hard failures (ambiguous target).
4. When the system can't safely proceed — an irreversible action awaiting a decision, a supervisor-only screen — it **escalates to a human who takes control of the same live session**, and hands control back when they're done.

> **The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the AI agent invokes it in production.**

The target application is a self-contained, intentionally *legacy-hostile* mock credit-union back office — "MockCore Teller" (framesets, table layouts, no test IDs) — with deterministic fault injection, so every scenario in [`/evidence/`](evidence/README.md) reproduces on your machine.

## Setup

Requires Node.js ≥ 20.

```bash
npm install
npx playwright install chromium
cp .env.example .env        # defaults work as-is for everything except discovery
```

**Keys/config:** only `cu discover` (the LLM-driven discovery run) needs `ANTHROPIC_API_KEY` in `.env`. **Everything else — the mock app, deterministic replay, the catalog, human-in-the-loop, and the entire test suite — runs fully offline with no key**, because the production path never calls a model. The committed artifact under `capabilities/` was produced by a real discovery run (its evidence is in `evidence/discovery/`), so you can exercise replay without re-running discovery.

```bash
npm test                    # 94 tests: schema, resolver, gate, engine, compiler, HITL — all local
```

## Demo path

**Terminal 1 — start the target app** (sign in manually if you like: `teller1` / `Passw0rd!` at http://localhost:4173):

```bash
npm run mock
```

**Terminal 2 — replay the discovered capability** (deterministic; no LLM, no API key):

```bash
npm run cu -- replay --capability capabilities/member.readSavingsBalance@1.0.0.json --param memberId=12345
# → status success, outputs.savingsBalance = "$4,821.97"

npm run cu -- replay --capability capabilities/member.readSavingsBalance@1.0.0.json --param memberId=99999
# → status business_outcome, code MEMBER_NOT_FOUND (a result, not a crash; exit code 0)
```

**Replay through a runtime error** — inject a mid-flow session timeout; the tenant overlay supplies the recovery and the run re-authenticates and completes:

```bash
npm run cu -- replay --capability capabilities/member.readSavingsBalance@1.0.0.json \
  --tenant tenants/demo-fcu.overlay.json --param memberId=12345 --inject-fault session_timeout:once
# → status success, recoveriesUsed: [SESSION_TIMEOUT]
```

**Replay into a hard failure** — two identical Search buttons; the engine refuses to guess:

```bash
npm run cu -- replay --capability capabilities/member.readSavingsBalance@1.0.0.json \
  --param memberId=12345 --inject-fault duplicate_button:on
# → status failed, TARGET_AMBIGUOUS at s6, expected/observed + both candidates + screenshot
# (demo runs write new folders under evidence/ by design; `git clean -fd evidence/` tidies up)
```

**Human-in-the-loop** — the risky flow: you are the operator. A headed browser opens; the terminal stops you twice (type `approve` for the irreversible confirm; then enter supervisor PIN `7391` in the browser window and type `resume`):

```bash
curl -s -X POST localhost:4173/__faults -H 'content-type: application/json' \
  -d '{"fault":"permission_denied","mode":"once"}'
npm run cu -- replay --capability capabilities/member.openSubAccount@1.0.0.json \
  --param memberId=12345 --param "acctType=HOLIDAY CLUB" --param "nickname=Vacation Fund" \
  --param initialDeposit=50.00 --hitl
# → escalates twice, you resolve on the live session, run completes with the confirmation number
```

**Run discovery yourself** (the only step needing `ANTHROPIC_API_KEY`; one run costs well under $1):

```bash
npm run cu -- discover \
  --goal "Sign in to MockCore Teller. Look up member 12345 and read the current balance of their REGULAR SAVINGS account from the member's accounts table into an output named 'savingsBalance'. After reading the balance, probe one exceptional state: search for member number 99999 (which does not exist) and declare the not-found behavior as business outcome MEMBER_NOT_FOUND with a marker you can see on screen. Then declare_done with capability_id 'member.readSavingsBalance'." \
  --param memberId=12345:internal \
  --env-param operatorId=MOCK_CU_USER:internal \
  --env-param operatorPassword=MOCK_CU_PASS:secret \
  --output savingsBalance:money:pii
# → compiles a DRAFT artifact; review it, then: npm run cu -- approve <file> --by "your name"
```

**Agent-facing catalog** (stretch goal) — capabilities as callable tools, invoked by name with typed args:

```bash
npm run cu -- catalog
npm run cu -- catalog --invoke member.readSavingsBalance --param memberId=10001
```

`replay`/`catalog` exit codes: `0` = success **or** a named business outcome (both legitimate results), `2` = failed, `3` = escalated.

## Repo map

```
apps/mock-cu/       the target app: legacy-hostile mock credit union + fault injection (POST /__faults)
src/core/           surface-agnostic vocabulary (Observation, SemanticAction) + templates
src/surface/        the Surface seam; Playwright web implementation (element map, locator ladder)
src/policy/         policy config, redaction, and the ActionGate — the single choke point for every action
src/schema/         capability artifact, conditions, tenant overlays, result contract (Zod)
src/discovery/      LLM agent loop, tool surface, recorder, deterministic compiler
src/replay/         condition evaluation + the deterministic replay engine
src/hitl/           session controller (control token), human-action capture, terminal operator
src/catalog/        agent-facing capability catalog
capabilities/       shipped artifacts (readSavingsBalance is LLM-discovered; openSubAccount hand-authored)
tenants/            tenant overlay example (bindings + additive patches)
policies/           the default allowlist/risk policy
evidence/           discovery + replay runs (see evidence/README.md for the index)
tests/              94 tests incl. live end-to-end scenarios against the mock app
                    (fixtures/ holds a hand-authored "gold" artifact used as the
                    engine test fixture and the compiler's diff baseline — the
                    SHIPPED readSavingsBalance artifact is the LLM-discovered one)
REPORT.md           design write-up
```

The design write-up — architecture, artifact schema rationale, determinism & error handling, heterogeneity/multi-tenant story, escalation model, safety, and cuts — is in [`REPORT.md`](REPORT.md).
