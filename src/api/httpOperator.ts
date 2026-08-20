/**
 * `Operator` implemented over HTTP — the test of whether the escalation seam
 * was designed right.
 *
 * The engine, the control token, the ActionGate lockout and the intervention
 * payload are untouched: the only thing that changes is who answers. A
 * terminal prompt becomes a dashboard, and the automation still cannot act
 * while a human holds the session.
 *
 * One capability does NOT survive the move, and it is stated rather than
 * papered over: `human_action_required` hands the operator the live Page so
 * they can do the work themselves (type a supervisor PIN, complete a
 * restricted form). An HTTP client has no Page. Those interventions are
 * therefore offered `abort` only, and the live-takeover path stays with the
 * terminal operator on a headed run. Resolving that properly means streaming
 * the session to the browser and forwarding input back — a real operator
 * console, deliberately out of scope.
 */
import { randomUUID } from 'node:crypto';
import type { Redactor } from '../policy/redact.js';
import type { Operator, OperatorSessionAccess } from '../hitl/sessionController.js';
import type { InterventionRequest, OperatorAction, OperatorResolution } from '../schema/result.js';

/**
 * What the registry hands out. Note what is NOT on it: the nonce.
 *
 * `SessionController` numbers interventions from a PER-RUN counter (`int-01`,
 * `int-02`…) while this registry is process-global, so a request id is not a
 * key — two concurrent runs both raising `int-01` is a supported state, and
 * keying on the bare id silently evicted one run's entry and let the other
 * run's timeout cancel it. `key` is the globally unique handle; `request.id`
 * stays what it always was, the run-local id the evidence records.
 */
export interface OpenIntervention {
  /** `${runId}:${request.id}` — unique across concurrent runs. */
  key: string;
  request: InterventionRequest;
  /** Resolutions this surface can actually honour (see the note above). */
  options: OperatorAction[];
  raisedAt: string;
  runId: string;
}

interface Pending extends OpenIntervention {
  /** Single-use secret required to resolve, so the guardrail is not simply an
   * unauthenticated local POST away from being bypassed. Deliberately absent
   * from `OpenIntervention`: the listing is an unauthenticated read, and a
   * nonce published there is a nonce that buys nothing. */
  nonce: string;
  /** The run's redactor, so the listing is scrubbed of regulated data the same
   * way the evidence log is. */
  redactor: Redactor | undefined;
  settle: (resolution: Omit<OperatorResolution, 'at'>) => void;
  timer: NodeJS.Timeout;
}

export interface HttpOperatorOptions {
  /**
   * How long a human has before the run gives up and aborts. Must stay under
   * the target application's idle-session lifetime, or the approved action
   * lands on an expired session.
   */
  timeoutMs?: number;
  /**
   * The run's redactor. `list()` is a live view of an intervention payload the
   * engine built from the target screen — `observationSummary` carries headings
   * and a slice of visible text, i.e. member names, balances and addresses.
   * Only the copy that goes through `RunLog.writeJson` was ever scrubbed, so
   * without this the operations console rendered a masked screenshot next to a
   * plaintext dump of the same screen.
   */
  redactor?: Redactor;
  onRaised?: (open: OpenIntervention) => void;
  /** Receives the registry KEY, not the run-local id — ids collide across runs. */
  onResolved?: (key: string) => void;
}

export class HttpOperator implements Operator {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly runId: string,
    private readonly opts: HttpOperatorOptions = {},
  ) {}

  /** Interventions currently awaiting a human, across all runs, by `key`. */
  static readonly open = new Map<string, Pending>();

  /** The registry handle for one run's intervention. */
  static keyFor(runId: string, id: string): string {
    return `${runId}:${id}`;
  }

  async handle(request: InterventionRequest, _session: OperatorSessionAccess): Promise<Omit<OperatorResolution, 'at'>> {
    // Only offer what this surface can honour. An approval is a decision and
    // travels fine; work on the live session does not.
    const options: OperatorAction[] = request.options.filter((o) => o !== 'resume');
    if (!options.includes('abort')) options.push('abort');

    const key = HttpOperator.keyFor(this.runId, request.id);

    return new Promise<Omit<OperatorResolution, 'at'>>((resolve) => {
      // The closure settles ITS OWN entry rather than looking one up by id.
      // The lookup version cleared whichever entry happened to hold the id at
      // the time, so run A's timeout cancelled run B's timer and deleted B —
      // leaving B's promise unsettled forever, its browser parked mid-
      // transaction on a signed-on session, and its concurrency slot burned.
      // A holder, because the entry and the closure that settles it refer to
      // each other: the timer must be able to clear ITS OWN entry.
      const slot: { self?: Pending } = {};
      let settled = false;
      const finish = (resolution: Omit<OperatorResolution, 'at'>): void => {
        if (settled) return;
        settled = true;
        const self = slot.self;
        if (self) {
          clearTimeout(self.timer);
          if (HttpOperator.open.get(key) === self) HttpOperator.open.delete(key);
          if (this.pending.get(key) === self) this.pending.delete(key);
        }
        this.opts.onResolved?.(key);
        resolve(resolution);
      };
      const timer = setTimeout(
        () =>
          finish({
            action: 'abort',
            note: `no operator resolved this within ${Math.round((this.opts.timeoutMs ?? 180_000) / 1000)}s — aborting rather than holding a live banking session open`,
          }),
        this.opts.timeoutMs ?? 180_000,
      );
      // Never keep the process alive purely to wait for a human.
      timer.unref?.();
      const entry: Pending = {
        key,
        request,
        options,
        nonce: randomUUID(),
        redactor: this.opts.redactor,
        raisedAt: new Date().toISOString(),
        runId: this.runId,
        settle: finish,
        timer,
      };
      slot.self = entry;
      this.pending.set(key, entry);
      HttpOperator.open.set(key, entry);
      this.opts.onRaised?.(entry);
    });
  }

  /**
   * Everything currently awaiting a human, for the dashboard to render.
   *
   * Redaction happens HERE, on the SERIALIZED view, exactly as `RunLog.event`
   * does it — scrubbing a pre-redaction object field by field is how values
   * slip through nested structures. Every consumer of this registry goes
   * through this method, so there is one boundary to audit rather than one per
   * caller.
   */
  static list(): OpenIntervention[] {
    return [...HttpOperator.open.values()].map((p) => {
      const view: OpenIntervention = {
        key: p.key,
        request: p.request,
        options: p.options,
        raisedAt: p.raisedAt,
        runId: p.runId,
      };
      if (!p.redactor) return view;
      return JSON.parse(p.redactor.apply(JSON.stringify(view))) as OpenIntervention;
    });
  }

  /**
   * The approval nonce for one open intervention.
   *
   * What the nonce buys: an API call that already knows an intervention exists
   * still cannot resolve it without a second, targeted read. What it does NOT
   * buy: authentication. Anything that can reach this process and read this
   * route can approve. The nonce's value therefore rests entirely on the
   * transport guard in front of it (loopback bind + Host check), which is why
   * it is served from its own route instead of being handed out with the
   * listing.
   */
  static nonceFor(key: string): string | undefined {
    return HttpOperator.open.get(key)?.nonce;
  }

  /**
   * Resolve an open intervention. Rejects an unknown key, a resolution this
   * surface cannot honour, or a bad nonce — this endpoint is the last thing
   * standing between an API call and money moving.
   */
  static resolve(key: string, action: OperatorAction, nonce: string, note?: string): { ok: true } | { ok: false; error: string } {
    const pending = HttpOperator.open.get(key);
    if (!pending) return { ok: false, error: `no open intervention '${key}'` };
    if (pending.nonce !== nonce) return { ok: false, error: 'invalid or missing approval nonce' };
    if (!pending.options.includes(action)) {
      return { ok: false, error: `'${action}' is not offered for this intervention (offered: ${pending.options.join(', ')})` };
    }
    pending.settle({ action, ...(note !== undefined ? { note } : {}) });
    return { ok: true };
  }
}
