# Evidence

Every replay run writes a redacted JSONL event stream (`run.jsonl`),
per-step screenshots (`steps/`), and a structured `result.json`; discovery
runs write the event stream, screenshots, the recorded `trace.json`, the
full (redacted, screenshot-elided) model `transcript.json`, the
`compile-report.json`, and the compiled `artifact.json`. Secrets never
appear anywhere in evidence (replaced at the write boundary, e.g.
`«secret:operatorPassword»`); `pii`-classed values — including values read
off the page, like the savings balance — are registered with the redactor
as soon as they are read and appear only masked (`***97`). All runs below were
executed against the local mock app and are reproducible with the commands
in the root README.

> **Runs against the live legacy target — MERIDIAN CORE — are indexed
> separately in [`meridian/README.md`](meridian/README.md).** That set is the
> newer and more complete one: seven recorded capabilities and one replay run
> per row of the runtime-state taxonomy. The runs below remain the MockCore
> set, and they are what keeps the offline demo path green with no network and
> no API key.

## Discovery

| Run | What it shows |
|---|---|
| `discovery/20260815-225407-02b9/` | **The LLM-driven discovery run** (claude-opus-4-8, 15 turns). `run.jsonl` logs every model turn, tool call, and ActionGate decision; `transcript.json` is the model transcript — the balance read is returned to the model masked, and the compiled artifact passes through the redactor before hashing, so the raw value cannot reach the shipped artifact; `trace.json` is the recorded action trace (readValue stored masked); `compile-report.json` lists every parameterization and pruning decision; `artifact.json` is the compiled draft as produced by this run. The shipped copy at `capabilities/member.readSavingsBalance@1.0.0.json` is this document after human review/approval (which updates the approval block and re-hashes). Includes the exceptional-state probe (searching nonexistent member 99999) that grounded the `MEMBER_NOT_FOUND` detector in observed text. |

## Replay (deterministic — no LLM in any of these)

| Run | Scenario | Result |
|---|---|---|
| `replay/20260815-225528-1u67/` | Discovered artifact, member 12345 | `success` — `savingsBalance: ***97` in evidence (real value returned to the caller); every locator resolved at strategy 0 |
| `replay/20260815-225531-obbv/` | **Generalization**: member 10001 — a member the discovery run never saw | `success` — `savingsBalance: ***50` |
| `replay/20260815-225535-3o15/` | Unknown member 99999 | `business_outcome MEMBER_NOT_FOUND` — a legitimate result the caller handles, not a failure |
| `replay/20260815-225537-ipwa/` | **Recoverable runtime error**: session-timeout fault injected mid-flow; run executed through the `demo-fcu` tenant overlay, which adds the `SESSION_TIMEOUT` recovery to the compiled artifact | `success` after re-authentication restart; `recoveriesUsed: SESSION_TIMEOUT` |
| `replay/20260815-225541-9hma/` | **Hard failure**: duplicate-Search-button fault (ambiguity trap) | `failed TARGET_AMBIGUOUS` at step s6 — refuses to guess; failure report names both candidates, expected vs observed, screenshot, and the step traces of everything that completed before it |
| `replay/20260819-201206-fmbe/` | **Cross-tenant, without the overlay**: the discovered artifact pointed at a second, re-skinned tenant instance (`npm run mock:summit` — Sign In renamed "Log On", Search renamed "Find Member") | `failed TARGET_NOT_FOUND` at s3 — an honest, named miss on the renamed control; the engine never guess-clicks a lookalike |
| `replay/20260819-201218-msr5/` | **Cross-tenant reuse**: the same artifact through `tenants/summit-fcu.overlay.json` — two additive `prependStrategy` patches, nothing else | `success` against the re-skinned tenant, every step at strategy 0 — the two patched steps resolve via the tenant's prepended locators, the other seven via the artifact's own — record once, reuse per tenant via a reviewed overlay, no re-recording |
| `replay/20260815-225543-qcc7/` | **Escalation & handoff** (operator scripted for reproducibility — same `Operator` seam the interactive terminal console implements): risky `member.openSubAccount` flow with the permission fault armed | `success` after two interventions: first the irreversible confirm paused for approval (`approve_risky`), then supervisor authorization escalated (`human_action_required`) — the operator entered the supervisor PIN on the same live session (3 captured `human_action` events, values recorded as length only — the PIN appears nowhere), resumed, and the step's postcondition verified the human's work. See `intervention-int-01.json` / `intervention-int-02.json` for the routed context and `interventions[].note` in `result.json` for the scripted-operator disclosure. |

## Notes

- Timeout-recovery evidence runs through the tenant overlay because the
  compiled artifact declares handling only for states its discovery run
  actually observed (`recoveries: []`); the overlay is the reviewed channel
  for hardening it.
- `_scratch/` (git-ignored) is working space used by the test suite; the
  committed runs above are the curated set. Running demo commands adds new
  run folders here; delete them by name. **Do not** run `git clean -fd evidence/`
  — it would also take any evidence not yet committed.
- `cu replay --times N` writes a loose `replay/stability-<runid>.json`
  report (not a run folder) alongside the N individual run folders. The
  stability report and `cu discover --hitl` are exercised by the offline
  test suite rather than by committed evidence runs.
- Screenshots in *these* runs may show fake seed data (members like "Alexis
  Testmember"); the seed is conspicuously synthetic by design. They predate
  profile-driven field classification, which is what blacks regulated values
  out of the image itself — see the MERIDIAN runs for screenshots captured
  with masking on, and `profiles/mockcore-teller.profile.json` for the
  equivalent declaration against this app.
