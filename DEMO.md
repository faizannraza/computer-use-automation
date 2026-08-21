# Demo runbook

Commands and navigation for a walkthrough against the live target, **MERIDIAN CORE**
(`web-sample.interface-hiring.com`).

Everything up to §5 is read-only. §5 posts a $1.00 transfer, and only after a human approves it.

---

## Start

```bash
cd computer-use-automation
npm run demo
```

The banner confirms what is enabled:

```
capability API  → http://127.0.0.1:4180/api/capabilities
dashboard       → http://127.0.0.1:4180/
chatbot         → http://127.0.0.1:4180/chat/
target          → MERIDIAN CORE — Member Services Platform v4.2.1
fault injection → ENABLED over HTTP (CU_ALLOW_INJECT=1) — harness mode
demo pacing     → every run HEADED, slow-mo 700ms — presentation mode, not production
```

`npm run demo` is `npm run api:meridian` plus two presentation settings:

| | |
|---|---|
| `CU_ALLOW_INJECT=1` | adds the target's own fault kinds to the invoke form. Off by default, because injection rewrites the request *beneath* the ActionGate — a recorded capability can never reach it, only the operator starting the process can. |
| `CU_DEMO_SLOW_MO=700` + `CU_DEMO_HEADED=1` | opens a visible browser and paces every run so it can be followed — including runs the chatbot starts. Off by default: production replays run headless at full speed. |

Open two tabs:

- **<http://127.0.0.1:4180/>** — operations console
- **<http://127.0.0.1:4180/chat/>** — chatbot

---

## 1. The catalog, and the policy it runs under

**Console → left column.**

Seven capabilities, one per function of the target: sign on, member inquiry, balances, funds
transfer, open share, update information, place account hold. Each is badged with its approval state
and its risk class. `member.placeHold` also declares `role: supervisor`.

**Console → header.**

```
origin  web-sample.interface-hiring.com     denies  /settings
actions 6                                   irreversible  escalate
```

Six allowed verbs — the automation has no vocabulary outside them. `/settings` is the target's
global fault-injection screen, and it is denied to the automation deliberately.

**Click `member.readBalances`** to open the typed invoke form. `memberId` is an integer with a
pattern the compiler inferred from the recording, and its description was mined from the field's own
on-screen label.

---

## 2. A capability driving the live application

**Console → `member.readBalances` → `memberId` = `103001` → Invoke.** *(~14s)*

A browser opens and drives the real application. While it runs, the console shows:

- **the step timeline** — intent, duration, action kind, risk class, and which rung of the locator
  ladder resolved the target (`strategy 0 · roleName · 1.00`)
- **a `PII` event** — sensitive fields registered for redaction
- **the live view** — the screenshot the run captured, with the member's name, e-mail, phone,
  address and every balance masked, while share IDs, types and statuses stay readable
- **`OUTPUTS`** — `shares : table`, rendered as typed rows

The mask is applied inside the same observation the classifier ran on, so a capture is never written
ahead of its own masking. What gets masked is what the profile declares — by label, by label pattern,
and by column header — and the two channels behave differently on purpose: text redaction is
**cumulative** (once a value has been seen anywhere in the run, every later write is scrubbed of it),
while screenshot masking is computed **per screen**. The caller receives the real values; the
evidence directory receives the masked ones.

### A second capability, a different shape of answer

**Console → `member.inquire` → `query` = `Lovelace`, `searchBy` = `name` → Invoke.** *(~12s)*

The same engine, the same gate, a different recorded flow — this one drives the *other* search mode
and returns `matches : table` with the member number, name and share count. The member's name is
masked in the evidence channel and returned in full to the caller.

Note the `searchBy` description on the form: *"Chosen in the 'Search by' field on screen. Offered at
recording time: number, name."* The compiler recorded the options the field offered. It does not
constrain the parameter to them, because the same code path handles share pickers whose options are
one member's accounts — pinning those would produce a capability that works for one member and
rejects everyone else.

---

## 3. The three ways a run can end

All three from the console's invoke form. Run history will show them side by side with different
status pills.

### 3a. A business outcome — a result, not an error

**`member.readBalances` → `memberId` = `999999`** *(~10s)*

→ `business_outcome` · `MEMBER_NOT_FOUND`. The CLI equivalent exits zero.

### 3b. A recoverable condition

**`member.readBalances` → `memberId` = `103001` → fault: `maintenance`** *(~18s)*

→ `success` · `recovered ×1`. A 503 interstitial was classified as recoverable, the flow restarted
from the entrypoint, and the run completed.

### 3c. Two layers refusing the same action

**`member.placeHold` → role `teller` → Invoke** — refused immediately, before a browser opens:

```
capability 'member.placeHold' declares requiresRole 'supervisor';
this invocation resolves to role 'teller'
```

The capability declares the authority it needs because that is the authority it was recorded with.
The check refuses in both directions: a routine teller capability cannot be invoked on supervisor
credentials either.

**Then, in Run history, open the committed run `20260820-141322-ad9v`.**

The same action, reaching the application through the CLI, which does not apply that pre-flight
check. MERIDIAN returns its supervisor-override screen; the run classifies that as a state only a
person can clear and escalates with context rather than guessing. Nothing was placed.

The application's own refusal is the authorization boundary. The pre-flight check is a convenience in
front of it.

---

## 4. Coverage — run history as the audit surface

**Console → Run history.**

The runs from §2 and §3 are at the top, with distinct status pills. Below them sits the committed
evidence set: **19 replay runs and 7 discovery runs**, all against the live target.

| | |
|---|---|
| 9 `success` | every one of the seven capabilities completes at least once |
| 6 `business_outcome` | member not found (by number and by name), transaction rejected, record not found, bad credentials |
| 3 `escalated` | supervisor override required, and an unattended irreversible run that stopped |
| 1 `failed` | an injected HTTP 500, failed fast against a declared anomaly |
| 4 rows badged `recovered ×N` | ran a recovery: two then reached success, two escalated to a human |

All six of the target's fault kinds — `validation`, `notfound`, `permission`, `timeout`,
`maintenance`, `server` — have a committed run. `evidence/meridian/README.md` indexes them one row
per runtime state, with a paragraph on each.

Switch the filter to **discovery** to see the seven recording runs the capabilities were compiled
from. Each holds the model transcript, the recorded trace, the compile report, and the draft artifact
before human approval.

Business outcome, recoverable condition and hard failure are separate schema sections, separate
result types, and one explicit priority order: postcondition → business outcome → recovery → anomaly
→ timeout.

---

## 5. The human approval gate

**Chatbot → click the chip:**

```
Transfer $1.00 from 103001-S0070-7 to 103001-MMKT-8    [needs approval]
```

The planner selects a capability by name from the catalog. It cannot invent a capability and it
cannot invent a parameter.

**Switch to the console.** *(~20s to the gate)* An approval bar appears:

- `HUMAN DECISION REQUIRED` · `APPROVE_RISKY` · `MEMBER.TRANSFERFUNDS@1.0.0` · `STEP S14`
- `RISK_NEEDS_ESCALATION: irreversible action requires human approval (policy mode: escalate)`
- a summary of the screen under review, in which the member's name is already masked

**Click `Approve — let it post`.** The confirmation number is returned as a typed output.

Three properties of that gate:

1. Approving requires the intervention's **one-time nonce**, which is not included in the listing
   endpoint.
2. Before acting, the engine re-observes, re-locates the control by identity, refuses if the match is
   ambiguous, refuses if the page navigated, and compares the form's values against those reviewed.
   The approval binds to the transaction, not to the button.
3. The HTTP operator implements the same interface the terminal operator does, and the ActionGate
   checks a control token on every action — so the automation is locked out while a human holds the
   session.

---

## 6. The artifacts were compiled, not written

```bash
npm run cu -- recompile capabilities-meridian/member.readBalances@1.0.0.json \
  --trace evidence/meridian/discovery/20260820-124803-gz6r \
  --app profiles/meridian-core.profile.json
```

```
member.readBalances: recompiles identically (modulo the approval block and its hash)
— the shipped artifact is exactly what this compiler produces from this trace.
```

Deterministic code, no network, no API key. Five of the seven reproduce byte for byte; the two that
do not are documented in `evidence/meridian/README.md`.

**Console → Audit trail → Element maps.**

Screenshots record what a person would have seen. The element map records what the locator ladder
saw — roles, accessible names, labels, row and column anchors — which is what explains why a target
resolved, or why it was refused as ambiguous.

---

## 7. Integrity and the offline suite

```bash
npm run cu -- validate capabilities-meridian/*.json     # schema + content hash, all seven
npm test                                                # 379 tests, ~26s, no network, no key
```

Every artifact is content-hashed over canonical JSON. Approving re-hashes, so a post-approval edit is
detectable.

---

# On demand

The walkthrough shows the mechanism once and the coverage as evidence, rather than running the same
engine seven times. If a specific capability or fault is asked for, these are the parameters.

### Every capability, with parameters that work

Read-only — safe to run at any point:

| Capability | Parameters |
|---|---|
| `session.signOn` | `branch` = `MAIN-001` |
| `member.readBalances` | `memberId` = `103001` |
| `member.inquire` | `query` = `Lovelace`, `searchBy` = `name` — or `query` = `103001`, `searchBy` = `number` |

Each of these changes the target permanently, and each pauses for approval first:

| Capability | Parameters | What it changes |
|---|---|---|
| `member.transferFunds` | `103001` / `103001-S0070-7` / `103001-MMKT-8` / `1.00` / `Q3 rebalance` | moves $1.00 between two shares |
| `member.openShare` | `103001` / `shareType` `MMKT` / `initialDeposit` `5.00` | adds a share, permanently |
| `member.updateInfo` | `103001` / e-mail / phone / address | overwrites the member's contact record |
| `member.placeHold` | `103001` / an **OPEN** share / `FRAUD` / a note — **role: supervisor** | locks a share |

Before naming a share, read the member: shares move between `OPEN` and `HOLD` as the target is used.

### Every fault kind

From the invoke form's **fault** dropdown, against `member.readBalances` with `memberId` = `103001`.
Leave *at step id* blank to arm it at the entrypoint, or name a step to arm it mid-flow.

| Fault | HTTP | Result |
|---|---|---|
| `maintenance` | 503 | `success` · recovered — restarts from the entrypoint |
| `timeout` | 440 | `success` · recovered — re-authenticates, re-minting the transaction token |
| `notfound` | 404 | `business_outcome` · `RECORD_NOT_FOUND` |
| `validation` | 400 | `business_outcome` · `TRANSACTION_REJECTED` |
| `permission` | 403 | `escalated` — a state only a person can clear |
| `server` | 500 | `failed` · fails fast against a declared anomaly rather than waiting out the clock |

Each already has a committed run in `evidence/meridian/README.md`, so the classification can be shown
without waiting for a live one.

### Natural errors, no injection

| | |
|---|---|
| No such member | `member.readBalances`, `memberId` = `999999` |
| No such surname | `member.inquire`, `query` = `Zzzznomatch`, `searchBy` = `name` |
| Bad credentials | committed run — `session.signOn` with an incorrect credential |
| Overdraw | committed run — a transfer exceeding the from-share balance |

---

# Optional extras

### The catalog an agent consumes

```bash
npm run cu -- catalog --dir capabilities-meridian
```

JSON-schema tool definitions — name, description, typed parameters, risk class — with no reference to
the underlying UI.

### The API directly

```bash
curl -s localhost:4180/api/capabilities | jq '.[].name'

curl -s -X POST localhost:4180/api/capabilities/member.readBalances/invoke \
  -H 'content-type: application/json' -d '{"params":{"memberId":"103001"}}'
```

### Repeat-run stability

```bash
npm run cu -- replay --capability capabilities-meridian/member.readBalances@1.0.0.json \
  --app profiles/meridian-core.profile.json --param memberId=103001 --times 3
```

Aggregates status consistency, output consistency and the per-step locator-strategy distribution —
the drift signal, summed across runs.

### The same artifact against a different, re-skinned application

Entirely offline. "Sign In" is renamed "Log On", "Search" is renamed "Find Member".

```bash
npm run mock            # terminal 1
npm run mock:summit     # terminal 2

# without the tenant overlay — an honest miss on the renamed control
npm run cu -- replay --capability capabilities/member.readSavingsBalance@1.0.0.json \
  --param memberId=12345 --base-url http://localhost:4174 --policy policies/summit-fcu.policy.json

# with two additive locator patches — succeeds, without re-recording
npm run cu -- replay --capability capabilities/member.readSavingsBalance@1.0.0.json \
  --tenant tenants/summit-fcu.overlay.json --param memberId=12345 --policy policies/summit-fcu.policy.json
```

### The offline arc, if the hosted target is unavailable

```bash
npm run mock

npm run cu -- replay --capability capabilities/member.readSavingsBalance@1.0.0.json --param memberId=12345
npm run cu -- replay --capability capabilities/member.readSavingsBalance@1.0.0.json --param memberId=99999
npm run cu -- replay --capability capabilities/member.readSavingsBalance@1.0.0.json \
  --tenant tenants/demo-fcu.overlay.json --param memberId=12345 --inject-fault session_timeout:once
npm run cu -- replay --capability capabilities/member.readSavingsBalance@1.0.0.json \
  --param memberId=12345 --inject-fault duplicate_button:on
curl -s -X POST localhost:4173/__reset

npm run api:mock        # console, dashboard and chatbot against the mock
```

---

# Reference

| Step | Duration |
|---|---|
| `readBalances`, headed and paced | ~14s |
| `readBalances` 999999 → business outcome | ~10s |
| `readBalances` + maintenance → recovered | ~18s |
| `placeHold` at the wrong role | immediate, no browser |
| Chatbot balance read | ~13s |
| Chatbot transfer, to the approval gate | ~20s |
| `cu recompile` | ~1s |
| `cu validate`, all seven MERIDIAN artifacts | under 1s |
| Offline test suite | ~26s |

| | |
|---|---|
| Capabilities | 7, 76 recorded steps, discovered then approved |
| Committed evidence | 19 live runs — 9 success, 6 business outcome, 3 escalated, 1 hard failure |
| Fault coverage | all six of the target's `inject` kinds |
| Recording cost | ~$0.90 per capability, ~$6 total |
| Replay | 1–3 seconds; no model, no tokens |

**Notes on the target.** It is shared and stateful — shares are opened and placed on hold between
runs, so read a member's balances before naming shares in a transfer. If every capability begins
failing identically with the same recovery code, the target's global fault mode has been enabled;
clear it at `/settings`.

**Note on output channels.** The console reads from the redacted evidence channel. CLI output is the
caller channel and is deliberately unredacted, since that is where real values are meant to be
returned.
