# Evidence

Every run — discovery or replay — writes a redacted JSONL event stream
(`run.jsonl`), per-step screenshots (`steps/`), and a structured
`result.json`. Secrets never appear anywhere in evidence (they are replaced
at the write boundary, e.g. `«secret:operatorPassword»`); `pii`-classed
values are masked (`***97`). All runs below were executed against the local
mock app and are reproducible with the commands in the root README.

## Discovery (the real LLM run)

| Run | What it shows |
|---|---|
| `discovery/20260815-182337-5eqq/` | **The genuine LLM-driven discovery run** (claude-opus-4-8, 15 turns). `run.jsonl` logs every model turn, tool call, and ActionGate decision; `transcript.json` is the full (redacted, screenshot-elided) model transcript; `trace.json` is the recorded action trace; `compile-report.json` lists every parameterization and pruning decision; `artifact.json` is the compiled output — the same document shipped at `capabilities/member.readSavingsBalance@1.0.0.json`. Includes the exceptional-state probe (searching nonexistent member 99999) that grounded the `MEMBER_NOT_FOUND` detector in observed text. |

## Replay (deterministic — no LLM in any of these)

| Run | Scenario | Result |
|---|---|---|
| `replay/20260815-184352-gj0h/` | Discovered artifact, member 12345 | `success` — `savingsBalance: ***97` in evidence (real value returned to the caller); every locator resolved at strategy 0 |
| `replay/20260815-182608-0203/` | **Generalization**: member 10001 — a member the discovery run never saw | `success` — `savingsBalance: ***50` |
| `replay/20260815-182621-ln0b/` | Unknown member 99999 | `business_outcome MEMBER_NOT_FOUND` — a legitimate result the caller handles, not a failure |
| `replay/20260815-184506-ixvt/` | **Recoverable runtime error**: session-timeout fault injected mid-flow; run executed through the `demo-fcu` tenant overlay, which adds the `SESSION_TIMEOUT` recovery to the compiled artifact | `success` after re-authentication restart; `recoveriesUsed: SESSION_TIMEOUT` |
| `replay/20260815-184405-80uu/` | **Hard failure**: duplicate-Search-button fault (ambiguity trap) | `failed TARGET_AMBIGUOUS` at step s6 — refuses to guess; failure report names both candidates, expected vs observed, with screenshot |
| `replay/20260815-184527-i4f0/` | **Escalation & handoff**: risky `member.openSubAccount` flow with the permission fault armed | `success` after TWO interventions: ① the irreversible confirm paused for approval (`approve_risky`); ② supervisor authorization escalated (`human_action_required`) — the operator entered the supervisor PIN on the same live session (3 captured `human_action` events, values recorded as length only — the PIN appears nowhere), resumed, and the step's postcondition verified the human's work. See `intervention-int-01.json` / `intervention-int-02.json` for the routed context. Operator resolutions came through the same `Operator` interface the interactive terminal console implements (notes in the records say so). |

## Notes

- Timeout-recovery evidence intentionally runs through the tenant overlay:
  the compiled artifact only declares handling for states its discovery run
  actually observed (`recoveries: []`), and the overlay is the reviewed
  channel for hardening it — that separation is a design feature, not a gap.
- Screenshots may show fake seed data (members like "Alexis Testmember");
  the seed is conspicuously synthetic by design. Screenshot redaction is a
  documented limitation (see REPORT.md § Safety).
