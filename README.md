# Computer-Use Automation System

> **Adaptation project:** this core is now pointed at **MERIDIAN CORE**
> ([web-sample.interface-hiring.com](https://web-sample.interface-hiring.com/)), with its
> capabilities exposed as a **callable API**, driven by a **chatbot**, and watchable on a
> **dashboard**. Start at [Running against MERIDIAN CORE](#running-against-meridian-core), and see
> [`ADAPTATION.md`](ADAPTATION.md) for what adapting actually took and what it exposed.

An end-to-end system that lets AI agents operate legacy back-office applications that have no API:

1. An **LLM-driven agent** takes a natural-language goal and operates a live UI (observe, decide, act), with every action passing through a policy gate.
2. The successful run is compiled — deterministically, no LLM — into a **typed, versioned capability artifact**: a reviewable contract with typed inputs, typed outputs, and named business outcomes.
3. That artifact **replays with no model in the loop**, using a semantic locator ladder and per-step checkpoints. Everything it sees is classified three ways: an expected business outcome ("no such member"), a recoverable condition (session timeout), or a hard failure (ambiguous target).
4. When the system can't safely proceed — an irreversible action awaiting a decision, a supervisor-only screen — it escalates to a human who **takes control of the same live session**, then hands control back.

> **The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the AI agent invokes it in production.**

Two target applications are wired up, each described by a file in [`profiles/`](profiles/) rather
than by code: **MERIDIAN CORE**, the hosted legacy console this adaptation targets, and **MockCore
Teller**, a self-contained, intentionally *legacy-hostile* mock (framesets, table layouts, no test
IDs) with deterministic fault injection, so every scenario in
[`evidence/replay/`](evidence/README.md) reproduces offline on your machine. The MERIDIAN runs in
[`evidence/meridian/`](evidence/meridian/README.md) are the live set and need the hosted target.

```
 goal (natural language)                        typed params
        |                                            |
        v                                            v
  discovery agent --> recorder --> compiler --> capability artifact --> replay engine
  (LLM in the loop)                (no LLM)     (typed, versioned,      (no LLM, ever)
        |                                        hashed, draft/approved)      ^
        |                                                                     |
        |                                             chatbot --> capability API --> dashboard
        |                                          (LLM plans;    (invoke by name,   (watch it run,
        |                                           never acts)    typed args)        approve, audit)
        |                                                                     |
        +-------------------+  every action, every path  +--------------------+
                            v                            v
                 +---------------------------------------------------+
                 | ActionGate: allowlist / action kinds / risk class  |
                 |             / HITL control token                   |
                 +-------------------------+-------------------------+
                                           v
                 Surface seam: observe / act / resolve
                 (Playwright web driver today; desktop by design)
                                           v
              MERIDIAN CORE (hosted) | MockCore Teller (local mock)
                    described by profiles/, not by code

  escalation:  SessionController hands the same live session to a human, then back
  evidence:    every run writes redacted JSONL + screenshots + a typed result
```

## Setup

Requires Node.js >= 20.

```bash
npm install
npx playwright install chromium
cp .env.example .env        # defaults work as-is for everything except discovery
```

**Keys/config:** `ANTHROPIC_API_KEY` in `.env` is needed by exactly two things — `cu discover`
(recording a new capability) and the chatbot's LLM planner. **Everything else — deterministic
replay, the capability API, the dashboard, the mock app, human-in-the-loop, and the entire test
suite — runs with no key**, because the production path never calls a model; the chatbot also ships
a deterministic `scripted` planner behind the same interface for exactly this reason. The committed
artifacts were produced by real discovery runs (evidence under `evidence/`), so replay needs nothing
re-recorded.

```bash
npm test                    # 274 tests: schema, resolver, gate, engine, compiler, profiles, API, HITL — all local
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

Add `--headed` to watch the browser drive the flow, and `--slow-mo 600` to pace it for an audience (a demo aid — production replays run headless at full speed).

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

curl -s -X POST localhost:4173/__reset   # ':on' faults stay armed — clear before the next demo
```

**Cross-tenant reuse, live** — a second, re-skinned tenant instance ("Summit FCU": Sign In renamed *Log On*, Search renamed *Find Member*). The same discovered artifact fails honestly without the tenant overlay, and succeeds with two additive `prependStrategy` patches — record once, reuse per tenant:

```bash
# Terminal 1 (alongside the default mock — this one serves port 4174):
npm run mock:summit         # same vendor product, tenant-re-skinned

# Terminal 2:
npm run cu -- replay --capability capabilities/member.readSavingsBalance@1.0.0.json \
  --param memberId=12345 --base-url http://localhost:4174 --policy policies/summit-fcu.policy.json
# → status failed, TARGET_NOT_FOUND at s3 (the renamed control) — an honest miss, never a guessed click

npm run cu -- replay --capability capabilities/member.readSavingsBalance@1.0.0.json \
  --tenant tenants/summit-fcu.overlay.json --param memberId=12345 --policy policies/summit-fcu.policy.json
# → status success — the tenant's locators fire at strategy 0; the artifact was not re-recorded
```

**Multi-run stability** (stretch goal) — replay N times and aggregate a flakiness report (status flapping, output consistency, per-step strategy-rank distribution — the drift signal, summed):

```bash
npm run cu -- replay --capability capabilities/member.readSavingsBalance@1.0.0.json \
  --param memberId=12345 --times 3
# → [STABLE] member.readSavingsBalance@1.0.0 over 3 runs + a stability-*.json report
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

**Run discovery yourself** (the only step needing `ANTHROPIC_API_KEY`; the committed 15-turn run cost ≈ $2 at Opus pricing). Note `--save-dir`: the default is `capabilities/`, and discovery refuses to overwrite an approved artifact there — point it somewhere fresh:

```bash
npm run cu -- discover --save-dir /tmp/cu-discovered --max-turns 20 \
  --goal "Sign in to MockCore Teller. Look up member 12345 and read the current balance of their REGULAR SAVINGS account from the member's accounts table into an output named 'savingsBalance'. After reading the balance, probe one exceptional state: search for member number 99999 (which does not exist) and declare the not-found behavior as business outcome MEMBER_NOT_FOUND with a marker you can see on screen. Then declare_done with capability_id 'member.readSavingsBalance'." \
  --param memberId=12345:internal \
  --env-param operatorId=MOCK_CU_USER:internal \
  --env-param operatorPassword=MOCK_CU_PASS:secret \
  --output savingsBalance:money:pii
# → compiles a DRAFT artifact; review it, then: npm run cu -- approve <file> --by "your name"
```

Discovery also takes `--hitl`: irreversible clicks then pause the *recording* for your approval on the live session (the same control-token handoff replay uses) — which is what makes risky flows discoverable rather than hand-authored.

**Agent-facing catalog** (stretch goal) — capabilities as callable tools, invoked by name with typed args:

```bash
npm run cu -- catalog
npm run cu -- catalog --invoke member.readSavingsBalance --param memberId=10001
```

`replay`/`catalog` exit codes: `0` = success **or** a named business outcome (both legitimate results), `2` = failed, `3` = escalated.

Demo runs write new folders under `evidence/` by design (every run leaves evidence). To clear them,
delete the new run directories by name — **do not** run `git clean -fd evidence/`, which would also
take any evidence not yet committed.

## Running against MERIDIAN CORE

The adaptation target is the hosted sample app — nothing to install, and no local mock involved.
Credentials are the brief's public demo operators; put them in `.env` (see `.env.example`):

```bash
MERIDIAN_TELLER_ID=teller1
MERIDIAN_TELLER_PASSWORD=password
MERIDIAN_SUPERVISOR_ID=super1
MERIDIAN_SUPERVISOR_PASSWORD=password
```

**Replay a capability from the command line** (deterministic; no model, no key):

```bash
npm run cu -- replay --capability capabilities-meridian/member.readBalances@1.0.0.json \
  --param memberId=100234 --app profiles/meridian-core.profile.json
# → success, outputs.shares = every share with its balance and status
```

`--app` points the run at the target's profile: base URL, policy, operator roles, app-level
recoveries, and the field classification that redacts regulated data. Add `--role supervisor` to
sign on with the other operator, `--headed --slow-mo 1000` to watch it drive, or
`--inject maintenance@s4` to force one of the app's documented faults on a chosen step.

### The API, the dashboard and the chatbot

One process serves all three:

```bash
CU_APP_PROFILE=profiles/meridian-core.profile.json \
CU_CAPABILITIES_DIR=capabilities-meridian \
CU_EVIDENCE_DIR=evidence/meridian \
npm run api
```

- **Dashboard** — <http://127.0.0.1:4180/> — the catalog, live runs with step timelines and
  streaming screenshots, run history (discovery *and* replay), the evidence trail, and the
  approval panel.
- **Chatbot** — <http://127.0.0.1:4180/chat/> — ask for a task in English; it invokes capabilities
  by name and reports the structured result, including when it stopped.
- **API** — invoke by name with typed args:

```bash
curl -s localhost:4180/api/capabilities | jq '.[].name'

curl -s -X POST localhost:4180/api/capabilities/member.readBalances/invoke \
  -H 'content-type: application/json' -d '{"params":{"memberId":"100234"}}'
```

**Irreversible capabilities pause for a human.** A transfer returns `202` with a run id, stops on
the confirmation screen, and posts nothing until someone approves it in the dashboard:

```bash
curl -s -X POST localhost:4180/api/capabilities/member.transferFunds/invoke \
  -H 'content-type: application/json' \
  -d '{"params":{"memberId":"101555","fromShare":"101555-S0001","toShare":"101555-CERT","amount":"5.00","memo":"demo"}}'
# → 202 {"runId":"…","status":"running","reason":"…pause for human approval before anything posts"}
curl -s localhost:4180/api/interventions              # the pending decision + its screenshot
curl -s localhost:4180/api/interventions/<key>/nonce  # fetched at approve time, never listed
```

Approving needs that intervention's one-time nonce, which is deliberately **not** on the listing —
otherwise the thing guarding an irreversible post is one unauthenticated GET away from whoever wants
it. Be clear about what that buys, though: the API has **no authentication**. The real boundary is
the transport — a loopback bind, plus a `Host` header check, because a loopback bind alone does not
survive DNS rebinding (a page whose DNS flips to `127.0.0.1` becomes same-origin, and then CORS is
irrelevant). The nonce means a caller must name one specific pending decision rather than harvest
approvals from a listing it polls. Real deployment needs real authentication here.

**Offline / no key.** Replay, the API, the dashboard and the whole test suite need no model — the
production path never calls one. Only two things do: `cu discover` (recording a new capability) and
the chatbot's LLM planner. The chatbot also ships a deterministic `scripted` planner behind the same
interface, so the surface is demonstrable with no key and no network to a model provider.

**Record a new capability** (the only step that uses the model):

```bash
npm run cu -- discover --app profiles/meridian-core.profile.json \
  --goal "Sign on, look up member 100234, and read every share with its balance and status." \
  --param memberId=100234:internal \
  --env-param operatorId=MERIDIAN_OPERATOR_ID:internal \
  --env-param operatorPassword=MERIDIAN_OPERATOR_PASSWORD:secret \
  --output shares \
  --save-dir /tmp/cu-discovered --evidence-dir evidence/meridian
```

`--output` takes `name[:type[:sensitivity]]`. Both hints are optional and neither can contradict the
recording: a value read with `read_table` is declared `type: 'table'` structurally, whatever the
flag says, because an artifact that calls a table a string parses fine and then hands the caller a
JSON blob instead of rows.

Recording a flow that posts money needs a human to authorise each irreversible click: add `--hitl`
to approve them interactively, or `--authorise-recording-as "<name>"` to pre-authorise a scripted
recording session — which stamps the authoriser's name onto every `intervention_resolved` event in
the run log, and flags the step in the compile report.

## Repo map

```
apps/mock-cu/       the target app: legacy-hostile mock credit union + fault injection + tenant skins
src/core/           surface-agnostic vocabulary (Observation, SemanticAction) + templates
src/surface/        the Surface seam; Playwright web implementation (element map, locator ladder)
src/policy/         policy config, redaction, and the ActionGate; every action funnels through it
src/schema/         capability artifact, conditions, tenant overlays, result contract (Zod)
src/discovery/      LLM agent loop, tool executor (the model-free harness half), recorder, compiler
src/replay/         condition evaluation, the deterministic replay engine, stability aggregation
src/hitl/           session controller (control token), human-action capture, terminal operator
src/catalog/        agent-facing capability catalog
src/profile/        app profiles: what is true of a TARGET APP rather than of one recorded flow
src/api/            the capability API (invoke by name), run registry, SSE, HTTP operator
src/chat/           the chatbot's planner — LLM tool-calling over the catalog, plus a scripted mode
web/                dashboard/ (watch, approve, audit) and chat/ — plain HTML/JS, no build step
capabilities/       shipped MockCore artifacts (readSavingsBalance LLM-discovered; openSubAccount hand-authored)
capabilities-meridian/  the seven MERIDIAN CORE capabilities, all LLM-discovered then approved
profiles/           the app profiles themselves: meridian-core, mockcore-teller
tenants/            tenant overlays (demo-fcu recoveries; summit-fcu re-skin re-ranking)
policies/           allowlist/risk policies: default, summit-fcu, meridian, meridian-harness
evidence/           MockCore runs + meridian/ (see each directory's README.md for the index)
tests/              274 tests (~25 s) incl. live end-to-end scenarios against the mock app;
                    fixtures/ holds a hand-authored gold artifact used only as
                    test fixture and compiler diff baseline
ADAPTATION.md       what pointing the core at MERIDIAN CORE took, and what it exposed
REPORT.md           the original core's design write-up
```

Two write-ups, deliberately separate. [`ADAPTATION.md`](ADAPTATION.md) covers this project: what
adapting to MERIDIAN CORE actually took, the API contract, how the runtime states are handled, and
what was cut. [`REPORT.md`](REPORT.md) is the original core's design write-up — architecture,
artifact schema rationale, determinism, the multi-tenant story, escalation, and safety.
