# Adapting to MERIDIAN CORE

The take-home built a core: an LLM discovers a flow on a UI-only app, deterministic code compiles
that run into a typed capability artifact, and the artifact replays with no model in the loop —
behind one policy gate, with evidence and a human-escalation path. This is what pointing that core
at **MERIDIAN CORE** took, and what it exposed.

## What adaptation took

**The core's load-bearing boundaries did not move.** Seven files under `src/` are byte-identical to
the commit before this project began, including the entire human-in-the-loop controller: a new
target, a new API, a dashboard, a chatbot and seven capabilities needed not one character of it. The
directory gained one new file — a `RecordingOperator`, 38 lines, so a discovery session can
pre-authorise the irreversible clicks it needs to record.

`ActionGate`, the single choke point every action passes through on both paths, was untouched by the
adaptation as well — `git diff 16b9db8 <the last adaptation commit> -- src/policy/actionGate.ts` is
empty. It is not in the seven because it changed a day later, for an unrelated reason: a review found
that its denied-path check was case-sensitive while the target's router is not, so `/Settings`
reached the one screen `/settings` denies. That is a security fix, not adaptation debt, and it is a
different claim than this one.

Two boundaries did change, and additively: the artifact schema gained a new action kind, a new
output type and three fields — every one `.optional()`, never `.default()` — and the `Surface` seam
gained three optional methods. The proof that this is extension rather than redefinition is that the
artifacts recorded against the *previous* application still hash-verify today, and a test asserts it.
The replay engine grew by about two-thirds again (653 to 1,118 lines); its classification order — the part that is a design
claim — is the same five lines it always was. MERIDIAN is a different shape of legacy — one page instead of a frameset, a
numbered menu, a hidden token on its posting forms — and the existing vocabulary already described it: labels
resolve through the preceding-cell fallback the first target needed, the shares table's header row is
mined by the same bold-row heuristic, buttons name themselves from `value`, and frame hints are empty.

What the target *did* expose were four gaps — three vocabulary, one real adaptation debt.

| # | Added | Coupling? |
|---|---|---|
| 1 | **App profiles** (`profiles/*.json`, `src/profile/appProfile.ts`) | The new configuration seam: identity, base URL, policy, operator roles, transaction token, fault adapter, app-level recoveries/anomalies, data classification. Two profiles ship; both are exercised by tests. |
| 2 | **`readTable`** — a new semantic action | **A genuine vocabulary gap.** The core could read a cell, not a table, and "every share with its balance and status" is table stakes for a servicing console. It threads through eight layers, from `SemanticAction` to the compiler. A limitation of the original design, not "the first target never asked". |
| 3 | **Credential roles** (`envOverrides`) | Artifacts declare stable env names; a profile maps them per role. MERIDIAN gates functions by operator, and two concurrent API invocations as different roles cannot share `process.env`. |
| 4 | **Fault-injection adapter** | **The adaptation debt.** The first app armed faults on its own endpoint; MERIDIAN takes a per-request `?inject=`. The concept transferred, the mechanism did not, so it moved into the profile behind a discriminated union. |

Everything else was configuration: an origin allowlist, a policy denying `/settings` exactly as the
first target's fault endpoint was denied, and a profile.

### What a live, shared target taught us that a mock could not

- **Row anchors were substring matches.** Someone else opened share `100234-S0001-3`, whose id
  *contains* `100234-S0001`. The ladder matched two rows, scored them equally, and refused to guess
  between two balances — correct behaviour, and a real bug. `rowAnchor` now takes `match: 'exact'`,
  which the compiler emits whenever the anchor is a whole cell.
- **Select labels carry live data.** `100234-S0001 - Regular Shares ($2,500.00)` is a *balance* inside
  a locator; it broke between recordings. The walker now captures option **values** alongside labels,
  and the compiler binds a param to the value — the id is stable, the label is not.
- **Reads anchored on the data being read.** A receipt's confirmation number differs every run, so
  `roleName "TRF-000123"` never matches twice. Legacy screens are label:value cell pairs, so the
  walker associates a value cell with its bold label cell and a `read` is addressed by that label.
- **Redaction silently disarmed a detector.** MERIDIAN's sign-on error reads *"Invalid operator ID
  or password."* — and the demo operator's credential **is** the word `password`. The marker was
  grounded against the raw screen, then redacted on its way to disk, so the artifact declared
  `BAD_CREDENTIALS` matching on `"Invalid operator ID or «secret:operatorPassword»."`: a string no
  screen can ever show. A bad login therefore reported as a hard `POSTCONDITION_TIMEOUT` — the exact
  business-outcome-versus-failure confusion this system exists to prevent, caused by its own safety
  machinery. Two guards now: the recorder rejects a marker that redaction would alter and tells the
  model to pick different text, and the schema refuses to load any artifact whose detector matches
  on redacted text, because a detector that can never fire is worse than none — it advertises
  handling that does not exist.
- **A shorter param value silently ate a longer one.** `memberId` is `101555`; `fromShare` is
  `101555-S0001`. The compiler substituted params in object order, so the shorter value claimed the
  span first and the transfer receipt's checkpoint compiled to `{memberId}-S0001:` instead of
  `{fromShare}:` — freezing the recording session's own share into the contract. The capability then
  succeeded *only* when replayed with the exact shares it was recorded with; any other pair **moved
  the money and reported `POSTCONDITION_TIMEOUT`**. Side effect executed, failure returned — the
  worst result this system can produce. Substitution now runs longest-value-first, and a lint flags
  the fingerprint (a `{param}` running straight into further identifier characters) at approval time,
  because reordering cannot fix the case where a recorded id carries a suffix no param declares.
- **One condition, two screens.** An overdraw does not render MERIDIAN's `TRANSACTION REJECTED`
  banner; it redisplays the form with *"The transaction could not be validated: Insufficient…"*.
  Matching only the banner — which is what the injected 400 shows — meant every *real* overdraw fell
  through to a hard timeout. The profile now matches either, which is precisely the kind of
  app-level truth that belongs in configuration rather than in a flow.

## The capability API

`POST /api/capabilities/:name/invoke` with `{params, options}` runs the deterministic replay and
returns a structured result; `GET /api/capabilities` is the typed catalog an agent picks from. The
contract *is* the artifact's contract — typed params in, typed outputs back, named business outcomes
— so the API adds naming and transport, not semantics. Three decisions worth defending:

- **Irreversible capabilities are forced async.** They will pause for a human, and a decision that
  takes minutes must not ride on a held-open HTTP request.
- **Two channels, deliberately.** An invoke response is the *caller* channel and carries real values;
  `GET /api/runs/:id` is the *evidence* channel, read from redacted disk. The same run reads
  differently through the two endpoints, on purpose.
- **`table` outputs are JSON strings internally, parsed at the edge.** One redaction boundary still
  covers them; callers still get structure. The schema enforces the pairing — an output fed by a
  `readTable` step that calls itself a scalar fails to load, because such an artifact parses fine and
  then hands the caller a blob.

**The chatbot** is a planner, not an actor: Anthropic tool-calling over the catalog, so its only
moves are capabilities that exist with params they declare. Composition falls out for free ("read
100234's balances, then move $50 from savings to checking" is two catalog calls) while everything
dangerous stays behind the same gate. A `scripted` planner sits behind the same interface — the seam
the brief invites, and why the demo path runs with no API key.

**The dashboard** is how a reviewer sees what happened: live events over SSE, masked screenshots as
they are captured, the element map behind each one (what the *locator ladder* saw, which is the only
thing that explains a resolution or a refusal), discovery *and* replay history read off disk, and the
approval panel. An approval there is not a UI convenience — `HttpOperator` implements the same
`Operator` interface the terminal console does, so the automation is genuinely blocked on it.

## Driving this UI reliably, and its runtime states

Determinism comes from the same three mechanisms as before — a locator ladder that refuses to guess,
condition-based waiting, explicit classification — with the target's taxonomy mapped onto it:

- **Business outcomes** (the caller handles them): `MEMBER_NOT_FOUND`, `BAD_CREDENTIALS` from the
  capabilities that observed them; `RECORD_NOT_FOUND`, `TRANSACTION_REJECTED` declared once in the
  profile and checked on *every* step, because no single flow owns them.
- **Recoverable**: `MAINTENANCE_INTERSTITIAL` and `SESSION_EXPIRED`, both cleared by restarting from
  the entrypoint — which mints a token bound to the new session rather than re-posting one bound to a session that has ended.
- **Anomaly** — fail fast instead of waiting out the clock: `APPLICATION_ERROR` on the 500 page.
- **Hard failures**: an ambiguous or unresolvable target.
- **Escalation**: a teller attempting Place Account Hold gets the app's own supervisor-override
  screen, which only a person can clear.

All six of the brief's `inject` kinds have a committed evidence run apiece, and three of the five
natural errors it names — bad login, overdraw, and a hold attempted by a non-supervisor.
`evidence/meridian/README.md` indexes every run one row per state, and says plainly which two states
have no run and why: producing an invalid-e-mail run means approving an irreversible submit against a
shared app on the chance it is rejected, and a natural idle timeout means waiting out the real
session TTL, which no test or demo can do.

Two of the brief's states are deliberately *not* separate codes. An overdraw renders the same screen
as any other rejected field, so it reports `TRANSACTION_REJECTED` and the caller reads the reason;
inventing `INSUFFICIENT_FUNDS` would mean pattern-matching prose the app never promised to keep
stable. And a last-name search matching several members is not exceptional at all — `readTable`
returns every match as a row, so "two Smiths" is a two-row answer, not an error.

The **hidden form token** — which the brief calls per-transaction and which the evidence shows is per-session — is where computer use beats request-reconstruction. We never read,
store or replay it: the browser submits the form the operator sees, so it is carried inherently. What
the system does is *assert* one is present before a posting step — the walker observes hidden inputs
by name, value deliberately never captured — so a form served without a token fails loudly instead of
posting something the core will reject.

The compiler emits that assertion for a posting step only when the token field was actually observed
in the state the step acts on. A flat "every posting step" rule would put an unsatisfiable
precondition on the Sign On step of all seven capabilities, which is worse than no assertion at all.

**That mechanism has never fired, and the reason is worth stating rather than hiding.** Across all
seven shipped artifacts there are zero token assertions. The compile report explains why in the
compiler's own words — *"no such hidden field was observed in the state those steps act on"* — but
that sentence is about the **recording**, not about MERIDIAN. The walker learned to observe hidden
inputs, and the recorder learned to carry them into the trace, *after* these seven flows were
recorded: `hiddenFields` appears on zero of the recorded actions in every committed `trace.json`, so
the compiler was reading absence of instrumentation and concluding absence of a token.

The replay evidence says the opposite. In `evidence/meridian/replay/20260820-141325-b1kn/`, the
element map for the state `member.transferFunds` posts from contains:

```json
{ "ref": 4, "role": "hidden", "name": "_token", "interactive": false, "value": "(present:12)" }
```

So the token *is* on the form that moves money, and the capability that moves it asserts nothing
about it. An earlier draft of this document read that compile-report line as evidence that MERIDIAN
does not put a token on every form — a correction of the brief's premise. It is not evidence of that,
and the claim is withdrawn. What the evidence does settle is narrower and still worth having: the
token is per-*session* rather than per-transaction — the same value recurs across forms within one
session and changes between sessions — and the profile records that with the runs that show it.

Re-recording the four posting capabilities with today's recorder would close this. It is the largest
single thing this project shipped incomplete.

## How the guarantees survive the new surface

The API is not a second path to the browser: it calls the same `replayCapability`, so the gate, the
policy, the risk handling and redaction all apply unchanged. Concretely, **the API cannot post money
unattended**: an irreversible step pauses, and resolving it needs that intervention's one-time nonce,
which is deliberately absent from the listing — a guard published by the endpoint it guards is not a
guard.

Stated plainly rather than left for a reviewer to find: **the API has no authentication.** Its
boundary is the transport — a loopback bind *plus* a `Host` check, because loopback alone does not
survive DNS rebinding. Fault injection is a harness affordance, refused on the API unless the server
is started with an explicit flag, since it rewrites requests to the live target beneath the gate.

The API refuses any invocation whose role differs from the one the capability was **recorded** with —
`requiresRole` when it declares one, the profile's default when it does not. The second clause is
where the work is. The compiler writes `requiresRole` only when it differs from the default, so the
three capabilities that move money declare nothing, and the obvious guard — "is `requiresRole` set?"
— would have waved exactly those three through on supervisor credentials. It would also have failed
quietly: the under-privileged direction is loud, because the app refuses it anyway and that refusal
is the real authorization boundary, but an over-privileged transfer succeeds, posts, and leaves no
trace beyond whichever operator id happened to be logged. Comparing against the recorded authority
catches both directions.

The CLI deliberately does not apply this pre-flight check, which is why the escalation is demonstrable
at all: the run reaches MERIDIAN's supervisor-override screen and hands the decision to a person.
Both are worth showing — the API refuses on authority it can check locally, the target refuses on
authority only it holds.

Redaction had to get stronger. Sensitivity annotations cover only what a *flow* declares, and a
servicing console puts far more on screen — a name search lists other members, none of whom is a
param or an output. The profile now classifies fields by label, by label pattern and by column
header; every observation in both discovery and replay is swept before anything is written; and the
matched elements are masked in the screenshot of that same observation. Share ids and statuses are
not regulated and stay readable, which is what keeps the evidence debuggable.

Recording all seven capabilities cost **about $6** in total — roughly $0.90 each, 113 model turns,
1.1M input tokens at `claude-opus-4-8`. Discovery is the only
place a model runs, it runs once per capability, and everything after it is deterministic. The
marginal cost of the ten-thousandth transfer is one browser session.

## What I cut, and what I would build next

- **`elevate`** — approving a supervisor escalation and retrying with elevated credentials. Designed,
  not shipped: on the real path the irreversible click has *already dispatched* before the 403 is
  observed, so this would release the double-execution guard on **every** invocation, on app-specific
  reasoning baked into the engine. The proven escalate + human-takeover path was the right trade for
  a day. Doing it safely needs three recorded conjuncts — the recovery's condition matched, an
  explicit `assumeNotCommitted` on the handler, and a human authorisation — with
  `irreversibleCompleted` left true.
- **A remote operator console.** `human_action_required` hands the operator the live `Page`; an HTTP
  client has none, so those interventions honestly degrade to `abort`-only and the live-takeover demo
  runs headed. Closing it means CDP screencast plus input forwarding — a product, not an afternoon.
- **Enum-typed `choose` params.** The compiler sees every option a select offered, so `searchBy` could
  compile to `enum: ['number','name']`. I did not ship it because the same path handles `fromShare`
  and `toShare`, whose options are *one member's* share ids — recording those as the domain yields a
  capability that works for member 100234 and rejects everyone else. Telling a static domain from a
  record-specific one is a question about the app, so it belongs in the profile.
- **Region-scoped conditions below the frame level**, multi-run confidence scoring feeding the
  catalog, and resume-from-step so a mid-flow expiry re-authenticates instead of restarting.
- **A second surface driver.** Still one, so the seam is exercised, not proven — the same sentence as
  before, and still true.
