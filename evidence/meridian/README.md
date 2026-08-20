# Evidence — MERIDIAN CORE

Every run here executed against the live target
(`https://web-sample.interface-hiring.com`) and writes a redacted JSONL event
stream, per-step screenshots, a per-observation **element map**, and a
structured `result.json`.

**On redaction.** Member names, e-mail, phone, address and balances are
classified by the app profile — by label, by label *pattern* (the transfer
receipt labels a balance with the share id itself), and by column header. They
are registered with the redactor as they are observed, and the matching
elements are blacked out in the screenshot of that same observation, so they
appear here only as masks (`***00`). The values still reach the *caller* in
full: an invoke response is the caller channel, this directory is the evidence
channel.

Two things are deliberately **not** masked, and both are load-bearing:

- **Share ids, share types and statuses.** They are not regulated, and leaving
  them readable is what makes these runs debuggable at all.
- **Caller-supplied inputs**, which appear in each run's `run_start` — including
  `member.inquire`'s search term. Redaction protects data the system *observed*
  on someone's screen; it does not withhold the caller's own input from the
  caller's own run log. The observed result of that search *is* masked: in the
  inquire run below, the matched member's name is `***da`, not `Lovelace, Ada`.

Anything a length limit touches is redacted **before** it is shortened —
element rows, model-facing observations, and the summary an operator reads when
approving. Exact-string redaction cannot match a value that has been cut in
half, so cutting first turns a length limit into a disclosure.

## Discovery — the capabilities were recorded, not written

| Capability | Discovery run | Model | Steps | Max risk | Requires role |
|---|---|---|---|---|---|
| `member.inquire` | `discovery/20260820-124803-nxnh/` | claude-opus-4-8 | 8 | reversible | — |
| `member.openShare` | `discovery/20260820-124803-16ki/` | claude-opus-4-8 | 13 | irreversible | — |
| `member.placeHold` | `discovery/20260820-125646-713v/` | claude-opus-4-8 | 14 | irreversible | supervisor |
| `member.readBalances` | `discovery/20260820-124803-gz6r/` | claude-opus-4-8 | 8 | reversible | — |
| `member.transferFunds` | `discovery/20260820-124803-5o6z/` | claude-opus-4-8 | 15 | irreversible | — |
| `member.updateInfo` | `discovery/20260820-125646-4tb7/` | claude-opus-4-8 | 12 | irreversible | — |
| `session.signOn` | `discovery/20260820-124803-nqfc/` | claude-opus-4-8 | 5 | reversible | — |

Each discovery directory holds the model transcript (screenshots elided), the
recorded `trace.json`, the `compile-report.json` listing every parameterisation
and pruning decision the compiler made — including its own lint warnings about
weak checkpoints and about locator rungs that could never match — and the
compiled draft `artifact.json`. The shipped copies in `capabilities-meridian/`
are those drafts after human review and `cu approve`, which flips the approval
state and re-hashes. `cu recompile <artifact> --trace <dir>` re-derives an
artifact from its trace and prints the diff, so "the compiler wrote this, not a
person" is checkable rather than asserted.

Recording a flow that posts money needs a human to authorise each irreversible
click. These sessions were pre-authorised for recording; the authorisation and
the authoriser's name are on the `intervention_resolved` event in each run's
`run.jsonl`, and the compile report flags the step as human-approved during
discovery.

`member.placeHold` is the one capability recorded as a **supervisor** — the app
refuses it for a teller — and it is the only one that declares `requiresRole`.

## Replay — the runtime-state taxonomy, one run per row

No model is involved in any of these.

| Run | Capability | Result | What it demonstrates |
|---|---|---|---|
| `replay/20260820-125909-m7jx/` | `session.signOn` | **success** | sign on / session |
| `replay/20260820-125911-2www/` | `member.readBalances` | **success** | read every share, balance and status |
| `replay/20260820-125913-vt04/` | `member.inquire` | **success** | member inquiry by LAST NAME → matches table |
| `replay/20260820-125915-z85j/` | `member.readBalances` | **success** · recoveries: MAINTENANCE_INTERSTITIAL | maintenance interstitial → RECOVERED |
| `replay/20260820-125919-hn2h/` | `member.readBalances` | **failed** — UNEXPECTED_STATE | application error → HARD FAILURE, fast |
| `replay/20260820-125921-psm2/` | `member.readBalances` | **success** · recoveries: SESSION_EXPIRED | session expired mid-flow → RECOVERED |
| `replay/20260820-125924-korr/` | `member.readBalances` | **business_outcome** — RECORD_NOT_FOUND | record not found (injected 404) → BUSINESS OUTCOME |
| `replay/20260820-125927-oi59/` | `member.inquire` | **business_outcome** — TRANSACTION_REJECTED | transaction rejected (injected 400) → BUSINESS OUTCOME |
| `replay/20260820-125929-j80w/` | `member.readBalances` | **business_outcome** — MEMBER_NOT_FOUND | no such member, by number → BUSINESS OUTCOME |
| `replay/20260820-125931-7gbr/` | `member.inquire` | **business_outcome** — MEMBER_NOT_FOUND | no such member, by name → BUSINESS OUTCOME |
| `replay/20260820-125933-9yut/` | `member.placeHold` | **escalated** — no_operator_available · recoveries: SUPERVISOR_OVERRIDE_REQUIRED | teller attempts a restricted hold → ESCALATED |
| `replay/20260820-125936-1b4e/` | `member.transferFunds` | **escalated** — no_operator_available | unattended transfer → ESCALATED, nothing posted |
| `replay/20260820-130209-g818/` | `member.transferFunds` | **success** | transfer posted after a human approved it in the dashboard |

### Detail

**`20260820-125909-m7jx` — sign on / session**  
The session capability replaying on its own, including the operator banner it reads back.

**`20260820-125911-2www` — read every share, balance and status**  
The headline read: one `readTable` returns all of a member's shares. Balances are masked in this evidence and returned in full to the caller.

**`20260820-125913-vt04` — member inquiry by LAST NAME → matches table**  
Search-by-name returning a typed `matches` table (member number, name, share count) from one `readTable` extraction.

**`20260820-125915-z85j` — maintenance interstitial → RECOVERED**  
A 503 maintenance interstitial injected at the entrypoint. Classified as recoverable, cleared by restarting the flow, and the run completed. `recoveriesUsed: MAINTENANCE_INTERSTITIAL`.

**`20260820-125919-hn2h` — application error → HARD FAILURE, fast**  
A 500 injected at the entrypoint. Matched the profile's APPLICATION_ERROR anomaly and failed immediately with the observed state instead of waiting out the step clock.

**`20260820-125921-psm2` — session expired mid-flow → RECOVERED**  
A 440 session timeout injected on the search step. Re-authenticated from the entrypoint — which also mints a fresh transaction token rather than re-posting a consumed one — and completed. `recoveriesUsed: SESSION_EXPIRED`.

**`20260820-125924-korr` — record not found (injected 404) → BUSINESS OUTCOME**  
A 404 injected mid-flow. Reported as the app-wide RECORD_NOT_FOUND outcome — a result the caller handles, not a crash.

**`20260820-125927-oi59` — transaction rejected (injected 400) → BUSINESS OUTCOME**  
A 400 injected mid-flow. Reported as TRANSACTION_REJECTED, the outcome a caller switches on to correct its inputs.

**`20260820-125929-j80w` — no such member, by number → BUSINESS OUTCOME**  
Natural, uninjected: searching member 999999. MEMBER_NOT_FOUND, grounded in text the discovery run literally stood in front of.

**`20260820-125931-7gbr` — no such member, by name → BUSINESS OUTCOME**  
Natural: a last-name search with no matches. The same outcome reached through the other search mode.

**`20260820-125933-9yut` — teller attempts a restricted hold → ESCALATED**  
Natural: a teller runs Place Account Hold. MERIDIAN returns its supervisor-override screen; the run classifies it as a state only a person can clear and escalates. With no operator attached it ends `escalated / no_operator_available` — nothing was placed.

**`20260820-125936-1b4e` — unattended transfer → ESCALATED, nothing posted**  
The safety property: an irreversible capability invoked with no operator attached runs to the confirmation screen and stops. `irreversibleCompleted: false`.

**`20260820-130209-g818` — transfer posted after a human approved it in the dashboard**  
Invoked over the API. It ran to the CONFIRM screen and stopped; a human fetched the intervention's one-time nonce and approved; only then did it post. Held 30s for the decision. `irreversibleCompleted: true`, confirmation returned, and the run records the operator role it used.

## How to reproduce any of these

```bash
npm run cu -- replay --capability capabilities-meridian/<capability>.json \
  --app profiles/meridian-core.profile.json --param <k>=<v> [--inject <kind>[@stepId]]
```

`--inject` uses the app's own documented `?inject=` mechanism, armed as a
one-shot rewrite of the request a chosen step triggers — which is how a fault
can land on a form POST, the only way to exercise a failure on a review→post
transition. It fires once per run, so a recovery that restarts does not walk
straight back into the same fault. It is a harness affordance: the CLI has it,
a recorded artifact cannot reach it, and the API refuses it unless the server
was started with `CU_ALLOW_INJECT=1`.

The live app is shared and stateful: balances, share ids and hold statuses move
between runs. Nothing here asserts a fixed balance, and the compiler refuses to
anchor a locator on a value it is reading.
