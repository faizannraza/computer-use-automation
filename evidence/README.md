# Evidence

Every replay run writes a redacted JSONL event stream (`run.jsonl`),
per-step screenshots (`steps/`), and a structured `result.json`; discovery
runs write the event stream, screenshots, the recorded `trace.json`, the
full (redacted, screenshot-elided) model `transcript.json`, the
`compile-report.json`, and the compiled `artifact.json`. Secrets never
appear anywhere in evidence (replaced at the write boundary, e.g.
`«secret:operatorPassword»`); `pii`-classed values — including values READ
off the page, like the savings balance — are registered with the redactor
the moment they exist and appear only masked (`***97`). All runs below were
executed against the local mock app and are reproducible with the commands
in the root README.

## Discovery (the real LLM run)

| Run | What it shows |
|---|---|
| `discovery/20260815-225407-02b9/` | **The genuine LLM-driven discovery run** (claude-opus-4-8, 15 turns). `run.jsonl` logs every model turn, tool call, and ActionGate decision; `transcript.json` is the model transcript — note the balance read is delivered to the model already masked, so it cannot echo the value into artifact prose; `trace.json` is the recorded action trace (readValue stored masked); `compile-report.json` lists every parameterization and pruning decision; `artifact.json` is the compiled draft as produced by this run. The shipped copy at `capabilities/member.readSavingsBalance@1.0.0.json` is this document after human review/approval (which updates the approval block and re-hashes). Includes the exceptional-state probe (searching nonexistent member 99999) that grounded the `MEMBER_NOT_FOUND` detector in observed text. |

## Replay (deterministic — no LLM in any of these)

| Run | Scenario | Result |
|---|---|---|
| `replay/20260815-225528-1u67/` | Discovered artifact, member 12345 | `success` — `savingsBalance: ***97` in evidence (real value returned to the caller); every locator resolved at strategy 0 |
| `replay/20260815-225531-obbv/` | **Generalization**: member 10001 — a member the discovery run never saw | `success` — `savingsBalance: ***50` |
| `replay/20260815-225535-3o15/` | Unknown member 99999 | `business_outcome MEMBER_NOT_FOUND` — a legitimate result the caller handles, not a failure |
| `replay/20260815-225537-ipwa/` | **Recoverable runtime error**: session-timeout fault injected mid-flow; run executed through the `demo-fcu` tenant overlay, which adds the `SESSION_TIMEOUT` recovery to the compiled artifact | `success` after re-authentication restart; `recoveriesUsed: SESSION_TIMEOUT` |
| `replay/20260815-225541-9hma/` | **Hard failure**: duplicate-Search-button fault (ambiguity trap) | `failed TARGET_AMBIGUOUS` at step s6 — refuses to guess; failure report names both candidates, expected vs observed, screenshot, and the step traces of everything that completed before it |
| `replay/20260815-225543-qcc7/` | **Escalation & handoff**: risky `member.openSubAccount` flow with the permission fault armed | `success` after TWO interventions: ① the irreversible confirm paused for approval (`approve_risky`); ② supervisor authorization escalated (`human_action_required`) — the operator entered the supervisor PIN on the same live session (3 captured `human_action` events, values recorded as length only — the PIN appears nowhere), resumed, and the step's postcondition verified the human's work. See `intervention-int-01.json` / `intervention-int-02.json` for the routed context. Operator resolutions came through the same `Operator` interface the interactive terminal console implements — see `interventions[].note` in `result.json`. |

## Notes

- Timeout-recovery evidence runs through the tenant overlay because the
  compiled artifact declares handling only for states its discovery run
  actually observed (`recoveries: []`); the overlay is the reviewed channel
  for hardening it.
- `_scratch/` (git-ignored) is working space used by the test suite; the
  committed runs above are the curated set. Running demo commands adds new
  run folders here — `git clean -fd evidence/` restores the committed set.
- Screenshots may show fake seed data (members like "Alexis Testmember");
  the seed is conspicuously synthetic by design. Screenshot redaction is a
  documented limitation (see REPORT.md § Safety).
