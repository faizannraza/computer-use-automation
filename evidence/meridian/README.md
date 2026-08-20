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
| `member.updateInfo` | `discovery/20260820-134302-g6i5/` | claude-opus-4-8 | 13 | irreversible | — |
| `session.signOn` | `discovery/20260820-133108-4llc/` | claude-opus-4-8 | 5 | reversible | — |

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

No model is involved in any of these. Together they cover **all six** of the
brief's `inject` kinds (validation, notfound, permission, timeout, maintenance,
server) and the natural errors it names.

| Run | Capability | Result | What it demonstrates |
|---|---|---|---|
| `replay/20260820-125911-2www/` | `member.readBalances` | **success** | read every share, balance and status |
| `replay/20260820-125913-vt04/` | `member.inquire` | **success** | member inquiry by LAST NAME → matches table |
| `replay/20260820-125915-z85j/` | `member.readBalances` | **success** · recoveries: MAINTENANCE_INTERSTITIAL | maintenance interstitial (503) → RECOVERED |
| `replay/20260820-125919-hn2h/` | `member.readBalances` | **failed** — UNEXPECTED_STATE | application error (500) → HARD FAILURE, fast |
| `replay/20260820-125921-psm2/` | `member.readBalances` | **success** · recoveries: SESSION_EXPIRED | session expired mid-flow (440) → RECOVERED |
| `replay/20260820-125924-korr/` | `member.readBalances` | **business_outcome** — RECORD_NOT_FOUND | record not found (404) → BUSINESS OUTCOME |
| `replay/20260820-125927-oi59/` | `member.inquire` | **business_outcome** — TRANSACTION_REJECTED | transaction rejected (400) → BUSINESS OUTCOME |
| `replay/20260820-125929-j80w/` | `member.readBalances` | **business_outcome** — MEMBER_NOT_FOUND | no such member, by number → BUSINESS OUTCOME |
| `replay/20260820-125931-7gbr/` | `member.inquire` | **business_outcome** — MEMBER_NOT_FOUND | no such member, by name → BUSINESS OUTCOME |
| `replay/20260820-133228-akda/` | `session.signOn` | **business_outcome** — BAD_CREDENTIALS | bad credentials → BUSINESS OUTCOME |
| `replay/20260820-133243-c1w6/` | `member.readBalances` | **escalated** — no_operator_available · recoveries: SUPERVISOR_OVERRIDE_REQUIRED | permission denied (403) → ESCALATED |
| `replay/20260820-133246-yihz/` | `session.signOn` | **success** | sign on / session |
| `replay/20260820-133638-1rq5/` | `member.transferFunds` | **business_outcome** — TRANSACTION_REJECTED | overdraw on a transfer → BUSINESS OUTCOME |
| `replay/20260820-140825-bt08/` | `member.transferFunds` | **success** | funds transfer POSTED after a human approved it |
| `replay/20260820-141005-7ckb/` | `member.placeHold` | **success** | account hold PLACED as supervisor |
| `replay/20260820-141057-2afg/` | `member.openShare` | **success** | new share OPENED after approval |
| `replay/20260820-141149-v394/` | `member.updateInfo` | **success** | member contact details UPDATED after approval |
| `replay/20260820-141322-ad9v/` | `member.placeHold` | **escalated** — no_operator_available · recoveries: SUPERVISOR_OVERRIDE_REQUIRED | teller attempts a restricted hold → ESCALATED |
| `replay/20260820-141325-b1kn/` | `member.transferFunds` | **escalated** — no_operator_available | unattended transfer → ESCALATED, nothing posted |

### Detail

**`20260820-125911-2www` — read every share, balance and status**  
The headline read: one `readTable` returns all of a member's shares. Balances are masked in this evidence and returned in full to the caller.

**`20260820-125913-vt04` — member inquiry by LAST NAME → matches table**  
Search-by-name returning a typed `matches` table (member number, name, share count) from one `readTable` extraction.

**`20260820-125915-z85j` — maintenance interstitial (503) → RECOVERED**  
Injected at the entrypoint. Classified as recoverable, cleared by restarting the flow, and the run completed. `recoveriesUsed: MAINTENANCE_INTERSTITIAL`.

**`20260820-125919-hn2h` — application error (500) → HARD FAILURE, fast**  
Injected at the entrypoint. Matched the profile's APPLICATION_ERROR anomaly and failed immediately with the observed state instead of waiting out the step clock.

**`20260820-125921-psm2` — session expired mid-flow (440) → RECOVERED**  
Injected on the search step. Re-authenticated from the entrypoint — which also mints a fresh transaction token rather than re-posting a consumed one — and completed. `recoveriesUsed: SESSION_EXPIRED`.

**`20260820-125924-korr` — record not found (404) → BUSINESS OUTCOME**  
Injected mid-flow. Reported as the app-wide RECORD_NOT_FOUND outcome — a result the caller handles, not a crash.

**`20260820-125927-oi59` — transaction rejected (400) → BUSINESS OUTCOME**  
Injected mid-flow. Reported as TRANSACTION_REJECTED, the outcome a caller switches on to correct its inputs.

**`20260820-125929-j80w` — no such member, by number → BUSINESS OUTCOME**  
Searching member 999999. MEMBER_NOT_FOUND, grounded in text the discovery run literally stood in front of.

**`20260820-125931-7gbr` — no such member, by name → BUSINESS OUTCOME**  
A last-name search with no matches — the same outcome reached through the other search mode.

**`20260820-133228-akda` — bad credentials → BUSINESS OUTCOME**  
Signing on with an incorrect credential. Reported as BAD_CREDENTIALS rather than as a timeout — which is what it used to do, because the mined marker read "Invalid operator ID or password." and the demo operator's credential IS the word `password`, so the redactor masked it and the detector could never match. The marker now stops short of the regulated span, and the schema refuses any artifact whose detector matches on redacted text.

**`20260820-133243-c1w6` — permission denied (403) → ESCALATED**  
The sixth and last inject kind. A 403 renders MERIDIAN's supervisor-override screen, which the profile classifies as a state only a person can clear; with no operator attached the run ends `escalated / no_operator_available`.

**`20260820-133246-yihz` — sign on / session**  
The session capability replaying on its own, including the operator banner it reads back.

**`20260820-133638-1rq5` — overdraw on a transfer → BUSINESS OUTCOME**  
The case the brief names. MERIDIAN redisplays the form with "The transaction could not be validated: Insufficient…" rather than its TRANSACTION REJECTED banner — a second screen for the same class of condition, which is why the profile matches on either. `irreversibleCompleted: false`; before this it reported as a hard POSTCONDITION_TIMEOUT.

**`20260820-140825-bt08` — funds transfer POSTED after a human approved it**  
Invoked over the API: it ran to the CONFIRM screen and stopped; a human fetched the intervention's one-time nonce and approved; only then did it post. Deliberately run against a share pair the capability was NEVER recorded with — which is what proves the receipt checkpoint binds to `{fromShare}` rather than to the recording's own shares.

**`20260820-141005-7ckb` — account hold PLACED as supervisor**  
The restricted function completing. Invoked with `options.role: supervisor`; the app lets a supervisor past the override screen, the irreversible post pauses for approval, and the run records `role: supervisor` — the audit field that answers "which runs used supervisor authority".

**`20260820-141057-2afg` — new share OPENED after approval**  
Open New Share through review → post, approved by a human, returning the confirmation number.

**`20260820-141149-v394` — member contact details UPDATED after approval**  
Update Member Information. The e-mail, phone and address params are declared `pii` in the contract, so they are masked here while the caller's own invoke response carries them in full.

**`20260820-141322-ad9v` — teller attempts a restricted hold → ESCALATED**  
A teller runs Place Account Hold. MERIDIAN returns its supervisor-override screen; the run classifies it as a state only a person can clear and escalates. Nothing was placed. Compare with the supervisor run above, which proceeds.

**`20260820-141325-b1kn` — unattended transfer → ESCALATED, nothing posted**  
The safety property: an irreversible capability invoked with no operator attached runs to the confirmation screen and stops. `irreversibleCompleted: false`.
### Two states with no run of their own, and why

- **Invalid e-mail or phone on Update Member Information.** MERIDIAN renders it
  on the same validation screen as an overdraw, so it resolves to the same
  `TRANSACTION_REJECTED` outcome through the same profile marker — which the
  overdraw run above proves fires. There is no committed run because producing
  one means approving an irreversible submit against a shared app on the chance
  it is rejected; the classification is demonstrated, the mutation is not worth
  it.
- **A natural idle session timeout.** The `SESSION_EXPIRED` recovery matches two
  markers because the app has two: the injected 440 shows `YOUR SESSION HAS
  TIMED OUT`, a real idle expiry shows `SESSION ENDED`. Both were observed while
  grounding the profile; only the injected one is committed as a run, because
  reproducing the natural one means idling out the real TTL, which no test or
  demo can wait for.

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
