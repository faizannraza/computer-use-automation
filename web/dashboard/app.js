/**
 * Capability Operations Console.
 *
 * One page, no router, no build. The load-bearing idea: `applyEvent` is the
 * ONLY thing that turns a run event into UI, and both the live SSE stream and a
 * historical run's recorded JSONL are pushed through it. A run you are watching
 * and a run you are auditing therefore cannot disagree.
 */

// ───────────────────────────── tiny DOM kit ─────────────────────────────

const $ = (id) => document.getElementById(id);

/** Build an element. Every string child becomes a TEXT node, so nothing the
 *  server sends can ever be parsed as markup. There is no innerHTML here. */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = String(v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, String(v));
  }
  for (const k of kids.flat()) {
    if (k === undefined || k === null || k === false || k === '') continue;
    e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return e;
}
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };
const badge = (text, tone) => h('span', { class: 'badge' + (tone ? ` badge-${tone}` : ''), text });
const pill = (status) => h('span', { class: `pill pill-${status || 'unknown'}`, text: status || 'unknown' });

const fmtMs = (ms) => (typeof ms !== 'number' || !isFinite(ms) ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtClock = (ts) => { const d = new Date(ts); return isNaN(+d) ? '' : d.toLocaleTimeString([], { hour12: false }); };
const fmtWhen = (ts) => { const d = new Date(ts); return isNaN(+d) ? '—' : d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); };

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `${res.status} ${res.statusText}`);
  return body;
}

function toast(message, tone) {
  const t = h('div', { class: `toast ${tone || ''}`, text: message });
  $('toasts').append(t);
  setTimeout(() => t.remove(), tone === 'err' ? 8000 : 4500);
}

function emptyState(title, detail) {
  return h('div', { class: 'empty' }, h('strong', { text: title }), detail);
}

// ───────────────────────────── state ─────────────────────────────

const S = {
  profile: null,
  caps: [],
  capByName: new Map(),
  run: null,        // { runId, kind, es, done, shots:[], stepRows:[], gates:{allowed,denied}, events:[], result }
  openInterventions: new Map(),
  pollTimer: null,
};

// ───────────────────────────── boot ─────────────────────────────

boot();

async function boot() {
  wireDialogs();
  $('history-refresh').addEventListener('click', () => loadHistory());
  $('history-kind').addEventListener('change', () => loadHistory());
  $('btn-evidence').addEventListener('click', openEvidence);
  $('invoke-form').addEventListener('submit', onInvokeSubmit);
  $('shot-stage').addEventListener('click', () => { const img = $('shot-stage').querySelector('img'); if (img) lightbox(img.src, img.dataset.file); });

  // Both, then the broken rows: the catalog route serves only what is
  // CALLABLE, and the files that refused to load ride on /api/profile.
  await Promise.allSettled([loadProfile(), loadCatalog()]);
  renderBrokenCapabilities();
  await loadHistory();
  setInterval(loadHistory, 8000);
  pollInterventions();

  // Deep link: /#run=<runId>[&kind=replay] opens straight into a run.
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('run')) {
    openRun(p.get('run'), p.get('kind') || 'replay');
  } else {
    // Otherwise the timeline is the biggest thing on the first screen and it
    // was rendering nothing at all — no heading, no hint, just white.
    $('timeline').append(emptyState(
      'No run open',
      'Pick a capability on the left to invoke it, or open a past run from history.',
    ));
  }
}

async function loadProfile() {
  try {
    const p = await api('/api/profile');
    S.profile = p;
    // The profile's title reads "MERIDIAN CORE — Member Services Platform
    // v4.2.1". Only two parts of that earn permanent header space: the name of
    // the application, and its version — a version bump is the likeliest reason
    // a recorded artifact stops resolving. The marketing descriptor and the
    // vendor do not, so they are dropped. `appId` stays because it names the
    // profile JSON driving this run, which is the thing that makes the target
    // swappable.
    const title = p.title || 'Capability Operations Console';
    const version = /\bv\d[\w.]*/.exec(title)?.[0];
    $('app-title').textContent = title.split('—')[0].trim() || title;
    $('app-meta').textContent = [version, p.appId].filter(Boolean).join(' · ') || '—';
    renderPolicy(p.policy || {}, p.baseUrl);
  } catch (err) {
    $('policy-strip').append(h('div', { class: 'policy-item is-guard' }, h('span', { class: 'k', text: 'profile' }), h('span', { class: 'v', text: String(err.message) })));
  }
}

/** The fence, stated in the header: what this automation may touch at all. */
function renderPolicy(policy, baseUrl) {
  const strip = clear($('policy-strip'));
  const item = (k, v, guard) => h('div', { class: 'policy-item' + (guard ? ' is-guard' : '') },
    h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v }));
  // Hostnames rather than full origins: this row exists to be CONFIRMED at a
  // glance, not read. It is now the only place the target's address appears,
  // so the chip carries the link that used to sit under the title.
  const host = (o) => { try { return new URL(o).host; } catch { return o; } };
  const origin = item('origin', (policy.allowedOrigins || []).map(host).join(' ') || 'none');
  if (baseUrl) {
    const link = h('a', { class: 'policy-link', href: baseUrl, target: '_blank', rel: 'noreferrer',
      title: `Open ${baseUrl}` });
    link.append(...origin.childNodes);
    origin.append(link);
  }
  strip.append(origin);
  strip.append(item('denies', (policy.deniedPathPrefixes || []).join(' ') || 'none'));
  strip.append(item('actions', `${(policy.allowedActions || []).length}`));
  strip.append(item('irreversible', policy.irreversibleActionMode || 'unknown', true));
}

// ───────────────────────────── catalog ─────────────────────────────

async function loadCatalog() {
  const box = clear($('catalog'));
  try {
    S.caps = await api('/api/capabilities');
  } catch (err) {
    box.append(emptyState('Catalog unavailable', String(err.message)));
    return;
  }
  S.capByName = new Map(S.caps.map((c) => [c.name, c]));
  $('cap-count').textContent = `${S.caps.length} recorded`;
  if (!S.caps.length) { box.append(emptyState('No capabilities', 'Record one with the discovery CLI, then reload.')); return; }

  for (const c of S.caps) {
    const riskTone = c.maxRisk === 'irreversible' ? 'err' : c.maxRisk === 'reversible' ? 'warn' : 'info';
    box.append(h('button', { class: 'cap-card', type: 'button', onclick: () => openInvoke(c) },
      h('div', {}, h('span', { class: 'cap-name', text: c.name }), ' ', h('span', { class: 'cap-ver mono', text: `v${c.version}` })),
      h('div', { class: 'cap-title', text: c.title || '' }),
      h('div', { class: 'badges' },
        badge(c.approval, c.approval === 'approved' ? 'ok' : 'warn'),
        badge(c.maxRisk, riskTone),
        c.requiresRole && badge(`role: ${c.requiresRole}`, 'accent'),
        badge(c.app || 'app'),
      ),
    ));
  }
}

/**
 * One row per artifact that did not load — marked, un-invokable, and carrying
 * the error verbatim.
 *
 * The alternative (show nothing) is what made a malformed artifact so
 * expensive: the console rendered a short catalog and no reason, and the
 * capability that is missing is precisely the one nobody can see. These rows
 * are deliberately NOT buttons: there is no artifact to build a form from, and
 * invoking the name answers 422 anyway.
 */
function renderBrokenCapabilities() {
  const broken = (S.profile && S.profile.catalog && S.profile.catalog.broken) || [];
  $('cap-count').textContent = `${S.caps.length} recorded${broken.length ? ` · ${broken.length} broken` : ''}`;
  if (!broken.length) return;
  const box = $('catalog');
  for (const b of broken) {
    box.append(h('div', { class: 'cap-card is-broken' },
      h('div', {}, h('span', { class: 'cap-name', text: b.name }), ' ',
        h('span', { class: 'cap-ver mono', text: 'does not load' })),
      h('div', { class: 'cap-title mono', text: b.file }),
      h('div', { class: 'badges' }, badge('unloadable', 'err'), badge('not callable', 'warn')),
      h('div', { class: 'hint', text: b.error }),
    ));
  }
}

// ───────────────────────────── invoke form ─────────────────────────────

let invokingCap = null;

function openInvoke(cap) {
  invokingCap = cap;
  $('invoke-title').textContent = cap.name;
  $('invoke-desc').textContent = cap.title || '';
  const fields = clear($('invoke-fields'));
  const schema = cap.inputSchema || { properties: {} };
  const required = new Set(schema.required || []);

  for (const [key, spec] of Object.entries(schema.properties || {})) {
    const id = `p_${key}`;
    const field = h('div', { class: 'field' });
    field.append(h('label', { for: id }, key, required.has(key) ? h('span', { class: 'req', text: '*' }) : null,
      h('span', { class: 'badge', text: spec.type || 'string', style: 'margin-left:8px' })));

    let input;
    if (Array.isArray(spec.enum)) {
      input = h('select', { id, name: key });
      if (!required.has(key)) input.append(h('option', { value: '', text: '— not set —' }));
      for (const opt of spec.enum) input.append(h('option', { value: opt, text: opt }));
    } else {
      input = h('input', { type: 'text', id, name: key, autocomplete: 'off',
        placeholder: (spec.examples && spec.examples[0]) ? `e.g. ${spec.examples[0]}` : '' });
      if (spec.pattern) input.pattern = spec.pattern;      // browser-side shape check
      if (required.has(key)) input.required = true;
    }
    field.append(input);
    if (spec.description) field.append(h('div', { class: 'hint' }, spec.description,
      spec.pattern ? [' ', h('code', { text: spec.pattern })] : null));
    fields.append(field);
  }
  if (!Object.keys(schema.properties || {}).length) {
    fields.append(h('div', { class: 'hint', text: 'This capability takes no caller-supplied parameters.' }));
  }

  // Operational controls — not part of the capability contract, but part of
  // how an operator wants to watch it run.
  fields.append(h('div', { class: 'fieldset-title', text: 'Run options' }));
  const roles = (S.profile && S.profile.roles) || [];
  const roleSel = h('select', { id: 'opt_role', name: 'role' });
  for (const r of roles) roleSel.append(h('option', { value: r, text: r, selected: r === (S.profile && S.profile.defaultRole) }));
  if (!roles.length) roleSel.append(h('option', { value: '', text: '— profile default —' }));
  fields.append(h('div', { class: 'field' }, h('label', { for: 'opt_role', text: 'Role (credentials used)' }), roleSel));

  fields.append(h('div', { class: 'row-2' },
    h('div', { class: 'field' }, h('label', { for: 'opt_slowmo', text: 'Slow-mo (ms per action)' }),
      h('input', { type: 'number', id: 'opt_slowmo', min: '0', max: '5000', step: '50', placeholder: '0' })),
    h('div', { class: 'field' }, h('label', { text: 'Browser' }),
      h('label', { class: 'check', style: 'margin-top:9px' }, h('input', { type: 'checkbox', id: 'opt_headed' }), 'Watch headed browser')),
  ));

  // Fault injection rewrites requests against the LIVE target. It is a harness
  // affordance, so the API only accepts it when the server was started with
  // CU_ALLOW_INJECT=1 — when it was not, the controls are not rendered at all
  // rather than rendered into a guaranteed 400.
  const faults = (S.profile && S.profile.faultKinds) || [];
  if (S.profile && S.profile.injectEnabled && faults.length) {
    const faultSel = h('select', { id: 'opt_fault' }, h('option', { value: '', text: '— none —' }));
    for (const f of faults) faultSel.append(h('option', { value: f, text: f }));
    fields.append(h('div', { class: 'row-2' },
      h('div', { class: 'field' }, h('label', { for: 'opt_fault', text: 'Inject fault' }), faultSel),
      h('div', { class: 'field' }, h('label', { for: 'opt_fault_step', text: 'at step id (optional)' }),
        h('input', { type: 'text', id: 'opt_fault_step', placeholder: 'e.g. s6' })),
    ));
  } else if (faults.length) {
    fields.append(h('div', { class: 'hint',
      text: 'Fault injection is disabled on this server (start it with CU_ALLOW_INJECT=1 to enable the harness controls).' }));
  }

  const warn = $('invoke-warning');
  if (cap.maxRisk === 'irreversible') {
    clear(warn).append(h('strong', { text: 'Irreversible capability. ' }),
      `Policy mode is "${(S.profile && S.profile.policy && S.profile.policy.irreversibleActionMode) || 'escalate'}": the run will pause at the irreversible step and wait for a human decision in the interventions panel before anything posts.`);
    warn.hidden = false;
  } else warn.hidden = true;

  $('invoke-modal').showModal();
}

async function onInvokeSubmit(ev) {
  ev.preventDefault();
  const cap = invokingCap;
  if (!cap) return;
  const params = {};
  for (const key of Object.keys((cap.inputSchema && cap.inputSchema.properties) || {})) {
    const v = $(`p_${key}`).value.trim();
    if (v !== '') params[key] = v;
  }
  const options = { async: true };            // always async: we want to watch it happen
  const role = $('opt_role').value; if (role) options.role = role;
  if ($('opt_headed').checked) options.headed = true;
  const slow = Number($('opt_slowmo').value); if (slow > 0) options.slowMoMs = slow;
  const faultSel = $('opt_fault');
  const fault = faultSel ? faultSel.value : '';
  if (fault) {
    const at = $('opt_fault_step').value.trim();
    options.inject = at ? { kind: fault, atStepId: at } : { kind: fault };
  }

  const btn = $('invoke-submit');
  btn.disabled = true; btn.textContent = 'Starting…';
  try {
    const res = await api(`/api/capabilities/${encodeURIComponent(cap.name)}/invoke`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ params, options }),
    });
    $('invoke-modal').close();
    toast(res.reason || `Invoked ${cap.name}`, 'ok');
    if (res.runId) openRun(res.runId, 'replay');
    loadHistory();
  } catch (err) {
    toast(`Invoke refused: ${err.message}`, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Invoke';
  }
}

// ───────────────────────────── the run view ─────────────────────────────

function resetRunView(runId, kind) {
  if (S.run && S.run.es) S.run.es.close();
  S.run = { runId, kind: kind || 'replay', es: null, done: false, shots: [], stepRows: [], gates: { allowed: 0, denied: 0 }, events: [], result: null, synthetic: false };
  clear($('timeline'));
  clear($('run-metrics'));
  $('result-panel').hidden = true;
  clear($('result-panel'));
  $('stream-banner').hidden = true;
  $('btn-evidence').disabled = false;
  $('run-capability').textContent = runId;
  $('run-sub').textContent = `${S.run.kind} · connecting…`;
  setRunStatus('running');
  clear($('shot-stage')).append(h('div', { class: 'shot-empty', text: 'Waiting for first screenshot…' }));
  clear($('filmstrip'));
  $('shot-count').textContent = '—';
}

const setRunStatus = (status) => { const el = $('run-status'); el.className = `pill pill-${status}`; el.textContent = status; };

/** Open a run: the SSE endpoint replays a finished run's history and then ends
 *  with `event: done`, so one transport covers live AND historical. */
async function openRun(runId, kind) {
  resetRunView(runId, kind);
  markHistoryActive(runId);
  history.replaceState(null, '', `#run=${encodeURIComponent(runId)}&kind=${encodeURIComponent(kind || 'replay')}`);
  // A run id that does not resolve — a stale deep link, a run pruned from
  // evidence — used to render as a permanently "running" run with an empty
  // timeline, because EventSource only reports "closed", never "404". Ask the
  // question that HAS an answer first.
  try {
    await api(`/api/runs/${encodeURIComponent(runId)}`);
  } catch {
    $('run-capability').textContent = 'Run not found';
    $('run-sub').textContent = `${kind || 'replay'} · ${runId}`;
    $('timeline').replaceChildren(emptyState(
      'No such run',
      'This run is not in evidence on disk. It may have been pruned, or the link may be from another machine.',
    ));
    return;
  }
  connectStream(runId);
}

function connectStream(runId) {
  const run = S.run;
  const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
  run.es = es;
  es.onmessage = (m) => {
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    // For a finished run the API replays its in-memory buffer AND then the same
    // events from disk, so the stream can contain the run twice. A second
    // `run_start` means "the stream is starting over" — re-render from there
    // rather than double-counting every step.
    if (ev.type === 'run_start' && run.events.length) restartRender();
    run.events.push(ev);
    applyEvent(ev);
  };
  es.onopen = () => { $('stream-banner').hidden = true; };
  es.addEventListener('done', () => { run.done = true; es.close(); finishRun(runId); });
  es.onerror = () => {
    if (run.done) return;
    showStreamBanner(runId, es.readyState === EventSource.CLOSED
      ? 'Event stream closed — this view is no longer live.'
      : 'Event stream interrupted. Retrying…');
  };
  $('run-sub').textContent = `${run.kind} · ${runId}`;
}

/** Drop everything rendered so far, keeping the connection and the run id. */
function restartRender() {
  const run = S.run;
  run.events = []; run.stepRows = []; run.shots = []; run.gates = { allowed: 0, denied: 0 };
  clear($('timeline')); clear($('filmstrip'));
  clear($('shot-stage')).append(h('div', { class: 'shot-empty', text: 'Waiting for first screenshot…' }));
  $('shot-count').textContent = '—';
}

function showStreamBanner(runId, message) {
  const b = clear($('stream-banner'));
  b.hidden = false;
  b.append(h('span', { text: message }), h('button', {
    class: 'mini-btn', type: 'button', text: 'Reconnect',
    onclick: () => { $('stream-banner').hidden = true; connectStream(runId); },
  }));
}

/** A run reached a terminal state — pull the structured result document. */
async function finishRun(runId) {
  try {
    const detail = await api(`/api/runs/${encodeURIComponent(runId)}`);
    if (!S.run || S.run.runId !== runId) return;
    S.run.summary = detail.summary;
    S.run.result = detail.result || null;
    if (detail.summary) S.run.kind = detail.summary.kind || S.run.kind;
    if (!S.run.events.length && Array.isArray(detail.events)) {
      // A run the store no longer streams (e.g. reloaded page): render from disk.
      for (const ev of detail.events) { S.run.events.push(ev); applyEvent(ev); }
    }
    if (!S.run.shots.length) synthesizeShots();
    if (!$('timeline').childElementCount) {
      $('timeline').append(S.run.events.length
        ? emptyState('No step activity', 'This run recorded evidence (screenshots and other events) but never started a step. Open the audit trail to see the raw stream.')
        : emptyState('This run recorded no events', 'Nothing reached the evidence log — the run never started, or its directory is empty.'));
    }
    renderResult(detail);
    loadHistory();
  } catch (err) {
    if (!S.run || S.run.runId !== runId) return;
    setRunStatus('error');
    if (!$('timeline').childElementCount) $('timeline').append(emptyState('Run not found', String(err.message)));
    toast(`Could not load run ${runId}: ${err.message}`, 'err');
  }
}

// ─────────────────── THE one event renderer (live + history) ───────────────────

/** Append/patch UI for exactly one run event. Never throws on an unknown type. */
function applyEvent(ev) {
  const run = S.run;
  if (!run || !ev || typeof ev !== 'object') return;
  const type = String(ev.type || 'event');
  const timeline = $('timeline');
  const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 60;

  switch (type) {
    case 'run_start': {
      $('run-capability').textContent = ev.capability || run.runId;
      $('run-sub').textContent = `${run.kind} · ${run.runId} · started ${fmtClock(ev.ts)}`;
      note(ev, 'info', 'RUN', h('span', {}, h('strong', { text: 'Run started' }),
        ev.params ? ` · params ${JSON.stringify(ev.params)}` : ''));
      pushShot('entrypoint');
      break;
    }
    case 'step_start': {
      const row = h('div', { class: 'ev', 'data-tone': 'running', 'data-step': ev.stepId || '' });
      const meta = h('span', { class: 'ev-meta' }, ev.kind && badge(ev.kind), ev.risk && badge(ev.risk, ev.risk === 'irreversible' ? 'err' : ev.risk === 'reversible' ? 'warn' : 'info'));
      const time = h('span', { class: 'ev-time', text: '…' });
      row.append(h('span', { class: 'dot' }), h('span', { class: 'ev-id mono', text: ev.stepId || '—' }),
        h('span', { class: 'ev-body' }, h('span', { class: 'ev-title', text: ev.intent || '(no intent recorded)' }), meta), time);
      asButton(row, `step ${ev.stepId} — open the raw record`, () => showRaw(`step ${ev.stepId}`, ev));
      timeline.append(row);
      run.stepRows.push({ stepId: ev.stepId, row, meta, time, open: true });
      break;
    }
    case 'resolved': {
      const s = stepRow(ev.stepId);
      // The drift signal: which locator strategy fired, and how confident it was.
      const rung = Number.isFinite(ev.strategyIndex) ? ev.strategyIndex : '—';
      const score = Number.isFinite(Number(ev.score)) ? Number(ev.score).toFixed(2) : '—';
      if (s) s.meta.append(badge(`strategy ${rung} · ${ev.strategy || '—'} · ${score}`,
        ev.strategyIndex === 0 ? 'ok' : 'warn'));
      break;
    }
    case 'extracted': {
      const s = stepRow(ev.stepId);
      if (s) s.meta.append(badge(`→ ${ev.into}`, 'accent'));
      break;
    }
    case 'step_ok': {
      const s = stepRow(ev.stepId);
      if (s) { s.row.dataset.tone = 'ok'; s.time.textContent = fmtMs(ev.ms); s.open = false; }
      pushShot(`after-${ev.stepId}`);
      break;
    }
    case 'gate': {
      const allowed = ev.decision && ev.decision.allowed;
      run.gates[allowed ? 'allowed' : 'denied'] += 1;
      // Allowed gates are the normal case and there are hundreds; only a REFUSAL
      // is an event a human needs to see. The counts go in the metrics strip.
      if (!allowed) {
        note(ev, 'err', 'GATE', h('span', {}, h('strong', { text: 'Action blocked by policy' }),
          ` · ${ev.kind || 'action'}${ev.risk ? ` (${ev.risk})` : ''}`,
          h('div', { class: 'hint', text: [(ev.decision && ev.decision.code), (ev.decision && ev.decision.reason), ev.location].filter(Boolean).join(' · ') })));
      }
      renderMetrics();
      break;
    }
    case 'business_outcome':
      note(ev, 'info', 'OUTCOME', h('span', {}, h('strong', { text: ev.code || 'business outcome' }),
        ev.stepId ? ` · declared at ${ev.stepId}` : '', h('div', { class: 'hint', text: 'A legitimate business result, not a failure.' })));
      pushShot(`outcome-${ev.code}`);
      break;
    case 'recovery_applied':
      note(ev, 'warn', 'RECOVERY', h('span', {}, h('strong', { text: ev.code || 'recovery' }),
        ` · handler ${ev.handler || '?'} · attempt ${ev.attempt}`));
      if (ev.handler === 'restartRun') pushShot('entrypoint');
      break;
    case 'fault_armed':
      note(ev, 'warn', 'FAULT', h('span', {}, h('strong', { text: `Fault armed: ${ev.kind}` }),
        ` · at ${ev.at || 'run start'}${ev.mechanism ? ` · ${ev.mechanism}` : ''}`));
      break;
    case 'intervention_raised':
      note(ev, 'warn', 'HUMAN', h('span', {}, h('strong', { text: `Escalated to a human — ${ev.kind}` }),
        ev.stepId ? ` at ${ev.stepId}` : '', h('div', { class: 'hint', text: ev.reason || '' })));
      pushShot('intervention');
      break;
    case 'intervention_resolved':
      note(ev, ev.resolution === 'abort' ? 'err' : 'ok', 'HUMAN', h('span', {},
        h('strong', { text: `Operator chose "${ev.resolution}"` }),
        ` · held ${fmtMs(ev.heldForMs)} · ${ev.humanActions || 0} action(s) on the live session`,
        ev.note ? h('div', { class: 'hint', text: ev.note }) : null));
      break;
    case 'human_action':
      note(ev, 'warn', 'TYPED', h('span', {}, `Human ${ev.kind} on `, h('span', { class: 'mono', text: ev.target || '?' }),
        typeof ev.valueLength === 'number' ? ` (${ev.valueLength} chars, value never captured)` : ''));
      break;
    case 'classified_fields':
      note(ev, 'info', 'PII', h('span', {}, h('strong', { text: 'Sensitive fields registered for redaction' }), ` · ${ev.registered}`));
      break;
    case 'approved_action_relocated':
      note(ev, 'warn', 'RELOCATE', h('span', {}, h('strong', { text: 'Approved action re-bound after the handoff' }),
        ` · ${ev.stepId}: ${ev.fromRef} → ${ev.toRef}`));
      break;
    case 'screenshot':
      addShot(ev.name, ev.file);
      break;
    case 'elements':
      attachElements(ev.file, ev.count);
      break;
    case 'run_result': {
      setRunStatus(ev.status || 'unknown');
      for (const s of run.stepRows) if (s.open) { s.row.dataset.tone = 'err'; s.time.textContent = '—'; s.open = false; }
      note(ev, ev.status === 'success' ? 'ok' : ev.status === 'business_outcome' ? 'info' : ev.status === 'escalated' ? 'warn' : 'err',
        'RESULT', h('span', {}, h('strong', { text: `Run ${ev.status}` }),
          ev.failure ? ` · ${ev.failure.class}${ev.failure.stepId ? ` at ${ev.failure.stepId}` : ''}` : ''));
      pushShot(ev.status === 'failed' ? 'failure' : 'final');
      break;
    }
    case 'run_error':
      setRunStatus('error');
      note(ev, 'err', 'ERROR', h('span', {}, h('strong', { text: 'Run aborted' }), ` · ${ev.reason || 'unknown reason'}`));
      break;
    default:
      // Unknown / future event types (discovery emits llm_turn, tool_use, …).
      note(ev, 'info', String(type).slice(0, 12), h('span', { class: 'mono', text: compact(ev) }));
  }

  if (atBottom) timeline.scrollTop = timeline.scrollHeight;
  renderMetrics();
}

const stepRow = (id) => { for (let i = S.run.stepRows.length - 1; i >= 0; i--) if (S.run.stepRows[i].stepId === id) return S.run.stepRows[i]; return null; };

/** Make a row that behaves like a button behave like one for the keyboard too:
 *  focusable, announced as a button, and activated by Enter or Space. */
function asButton(row, label, onActivate) {
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', label);
  row.addEventListener('click', onActivate);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); }
  });
  return row;
}

/** A non-step event row. */
function note(ev, tone, label, body) {
  const row = h('div', { class: 'ev ev--note', 'data-tone': tone },
    h('span', { class: 'dot' }), h('span', { class: 'ev-id mono', text: label }),
    h('span', { class: 'ev-body' }, body), h('span', { class: 'ev-time', text: fmtClock(ev.ts) }));
  asButton(row, `${label} event — open the raw record`, () => showRaw(ev.type || 'event', ev));
  $('timeline').append(row);
}

const compact = (ev) => { const o = { ...ev }; delete o.ts; delete o.type; return JSON.stringify(o).slice(0, 400); };

function renderMetrics() {
  const run = S.run; if (!run) return;
  const ok = run.stepRows.filter((s) => s.row.dataset.tone === 'ok').length;
  const box = clear($('run-metrics'));
  const m = (k, v) => h('div', { class: 'metric' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v }));
  box.append(m('steps ok', `${ok}/${run.stepRows.length}`));
  box.append(m('gate checks', `${run.gates.allowed}✓ ${run.gates.denied}✕`));
  // No `shots` metric: the Live View panel already counts its own frames, and
  // at 1280 this third column pushed the "Audit trail" button off the header.
}

// ───────────────────────────── screenshots ─────────────────────────────

function addShot(name, file) {
  const run = S.run; if (!run || !file) return;
  if (run.shots.some((s) => s.file === file)) return;
  const url = `/api/runs/${encodeURIComponent(run.kind)}/${encodeURIComponent(run.runId)}/evidence/${file}`;
  const shot = { name: name || file, file, url };
  run.shots.push(shot);
  $('shot-count').textContent = `${run.shots.length} frames`;

  const thumb = h('button', { class: 'thumb', type: 'button', title: shot.name, onclick: () => setStage(shot) },
    h('img', { src: url, alt: shot.name, onerror: () => dropShot(shot, thumb) }));
  $('filmstrip').append(thumb);
  shot.thumb = thumb;
  setStage(shot);
  $('filmstrip').scrollLeft = $('filmstrip').scrollWidth;
}

/** A synthesized path that does not exist on disk removes itself silently. */
function dropShot(shot, thumb) {
  thumb.remove();
  S.run.shots = S.run.shots.filter((s) => s !== shot);
  $('shot-count').textContent = S.run.shots.length ? `${S.run.shots.length} frames` : '—';
  const last = S.run.shots[S.run.shots.length - 1];
  if (last) setStage(last); else clear($('shot-stage')).append(h('div', { class: 'shot-empty', text: 'No screenshots in this run' }));
  renderMetrics();
}

/**
 * Pair an element map with the frame captured at the same moment.
 *
 * A screenshot shows what a person would have seen; the element map shows what
 * the LOCATOR LADDER saw — roles, accessible names, labels, row and column
 * anchors. That is the only thing that explains why a target resolved, resolved
 * to the wrong node, or was refused as ambiguous, so the two belong side by
 * side rather than in separate places.
 *
 * RunLog names both from the same counter (`003-after-s2.png` and
 * `003-after-s2.elements.json`), so the match is by that stem. A map with no
 * frame still gets listed on its own in the evidence drawer.
 */
function attachElements(file, count) {
  const run = S.run; if (!run || !file) return;
  const stem = String(file).replace(/\.elements\.json$/, '');
  const shot = run.shots.find((s) => s.file.replace(/\.png$/, '') === stem);
  if (shot) {
    shot.elementsFile = file;
    shot.elementsCount = count;
    const staged = $('shot-stage').querySelector('img');
    if (staged && staged.dataset.file === shot.file) setStage(shot);
  }
  (run.elementMaps = run.elementMaps || []).push({ file, count });
}

function setStage(shot) {
  const stage = clear($('shot-stage'));
  stage.append(h('img', { src: shot.url, alt: shot.name, 'data-file': shot.file }));
  const cap = h('figcaption', { class: 'shot-cap' }, `${shot.file} — ${shot.name}`);
  if (shot.elementsFile) {
    cap.append(' · ', h('button', {
      class: 'linkish', type: 'button',
      text: `element map (${shot.elementsCount} elements)`,
      onclick: () => openElementMap(shot.elementsFile),
    }));
  }
  stage.append(cap);
  for (const s of S.run.shots) if (s.thumb) s.thumb.classList.toggle('is-active', s === shot);
}

/** Fetch and show one element map. Values are redacted on disk, as everywhere. */
async function openElementMap(file) {
  const body = clear($('evidence-body'));
  body.append(h('div', { class: 'hint', style: 'margin-bottom:12px' },
    `Element map — ${file}. This is what the locator ladder saw when the frame beside it was captured; `,
    'classified values are masked here exactly as they are in every other evidence file.'));
  const pre = h('pre', { class: 'ev-raw', text: 'loading…' });
  body.append(pre);
  $('evidence-modal').showModal();
  try {
    const res = await fetch(evUrl(file));
    if (!res.ok) throw new Error(`${res.status}`);
    pre.textContent = JSON.stringify(await res.json(), null, 2);
  } catch (err) {
    pre.textContent = `Could not read ${file}: ${err.message}`;
  }
}

/**
 * Compatibility shim for evidence recorded before RunLog announced screenshots
 * on the event stream: the filenames are deterministic (a running counter plus
 * the shot's name), so we can reconstruct them from the event ORDER and let any
 * guess that 404s remove itself. Used only when a run emitted no screenshot
 * events at all, so it can never fight the authoritative ones.
 */
function pushShot(name) {
  const run = S.run;
  if (!run || !run.syntheticAllowed) return;
  run.syntheticIndex = (run.syntheticIndex || 0) + 1;
  addShot(name, `steps/${String(run.syntheticIndex).padStart(3, '0')}-${String(name).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60)}.png`);
}

function synthesizeShots() {
  const run = S.run;
  if (!run || run.shots.length || !run.events.length) return;
  run.syntheticAllowed = true; run.syntheticIndex = 0;
  const order = ['run_start', 'step_ok', 'business_outcome', 'recovery_applied', 'intervention_raised', 'run_result'];
  for (const ev of run.events) {
    if (!order.includes(ev.type)) continue;
    if (ev.type === 'run_start') pushShot('entrypoint');
    else if (ev.type === 'step_ok') pushShot(`after-${ev.stepId}`);
    else if (ev.type === 'business_outcome') pushShot(`outcome-${ev.code}`);
    else if (ev.type === 'recovery_applied' && ev.handler === 'restartRun') pushShot('entrypoint');
    else if (ev.type === 'intervention_raised') pushShot('intervention');
    else if (ev.type === 'run_result') pushShot(ev.status === 'failed' ? 'failure' : 'final');
  }
  run.syntheticAllowed = false;
}

// ───────────────────────────── result panel ─────────────────────────────

function renderResult(detail) {
  const panel = clear($('result-panel'));
  const result = detail.result;
  const summary = detail.summary || {};
  panel.hidden = false;
  const status = (result && result.status) || summary.status || 'unknown';
  setRunStatus(status);

  // The recovery badge sits in the HEAD, beside the status pill: a run that
  // reached 'success' the hard way says so where the status is read, not only
  // in the "Recoveries applied" section further down the panel.
  panel.append(h('div', { class: 'result-head' }, h('h3', { text: 'Result' }), pill(status),
    recoveryBadge((result && result.recoveriesUsed) || summary.recoveries),
    result && result.irreversibleCompleted ? badge('IRREVERSIBLE ACTION DISPATCHED', 'err') : null,
    summary.durationMs ? badge(`duration ${fmtMs(summary.durationMs)}`) : null,
    result && result.evidenceDir ? badge(result.evidenceDir) : null));

  if (!result) {
    panel.append(h('div', { class: 'hint', text: 'No result document was written for this run (it may predate the result contract, or it is a discovery run).' }));
    return;
  }
  const cap = S.capByName.get(result.capabilityId);

  if (result.status === 'business_outcome') {
    panel.append(h('div', { class: 'detail-box tone-info' },
      h('div', { class: 'output-k', text: 'BUSINESS OUTCOME' }),
      h('div', { class: 'output-v', text: result.code || '—' }),
      h('div', { class: 'output-desc', text: result.message || '' })));
  }

  const outs = Object.entries(result.outputs || {});
  if (outs.length) {
    panel.append(h('div', { class: 'sub-label', text: 'Outputs' }));
    const box = h('div', { class: 'outputs' });
    for (const [k, v] of outs) {
      const declared = cap && cap.outputs && cap.outputs[k];
      const cell = h('div', { class: 'output' }, h('div', { class: 'output-k' }, k, declared ? ` : ${declared.type}` : ''));
      const table = asTable(v);
      if (table) cell.append(h('div', { class: 'table-wrap' }, table));
      else cell.append(h('div', { class: 'output-v', text: typeof v === 'string' ? v : JSON.stringify(v) }));
      if (declared && declared.description) cell.append(h('div', { class: 'output-desc', text: declared.description }));
      box.append(cell);
    }
    panel.append(box);
  }

  if (result.status === 'failed' && result.failure) {
    const f = result.failure;
    panel.append(h('div', { class: 'sub-label', text: 'Failure' }));
    panel.append(h('div', { class: 'detail-box tone-err' },
      h('div', { class: 'result-head' }, badge(f.class, 'err'), f.stepId ? badge(`at ${f.stepId}`) : null),
      h('dl', { class: 'kv' }, h('dt', { text: 'expected' }), h('dd', { text: f.expected || '—' })),
      h('div', { class: 'sub-label', text: 'observed' }), h('pre', { class: 'obs', text: f.observed || '—' }),
      f.screenshotRef ? h('button', { class: 'mini-btn', type: 'button', text: 'Open failure screenshot', style: 'margin-top:8px',
        onclick: () => lightbox(evUrl(f.screenshotRef), f.screenshotRef) }) : null));
  }

  if (result.status === 'escalated') {
    panel.append(h('div', { class: 'sub-label', text: 'Escalation' }));
    panel.append(h('div', { class: 'detail-box tone-warn' },
      h('dl', { class: 'kv' },
        h('dt', { text: 'intervention' }), h('dd', { text: result.interventionId || '—' }),
        h('dt', { text: 'resolution' }), h('dd', { text: result.resolution || '—' }),
        h('dt', { text: 'reason' }), h('dd', { text: result.reason || '—' }))));
  }

  if ((result.recoveriesUsed || []).length) {
    panel.append(h('div', { class: 'sub-label', text: 'Recoveries applied' }));
    panel.append(h('div', { class: 'badges' }, result.recoveriesUsed.map((r) => badge(`${r.code} ×${r.attempts}`, 'warn'))));
  }

  if ((result.interventions || []).length) {
    panel.append(h('div', { class: 'sub-label', text: 'Human handoffs' }));
    for (const i of result.interventions) {
      panel.append(h('div', { class: 'detail-box tone-warn', style: 'margin-top:6px' },
        h('div', { class: 'result-head' }, badge(i.kind, 'warn'), badge(i.resolution, i.resolution === 'abort' ? 'err' : 'ok'),
          i.stepId ? badge(`at ${i.stepId}`) : null, badge(`held ${fmtMs(i.heldForMs)}`), badge(`${i.humanActions} human action(s)`)),
        h('div', { class: 'hint', text: i.reason || '' }),
        i.note ? h('div', { class: 'hint', text: `note: ${i.note}` }) : null));
    }
  }
}

/** Render a declared `table` output as a real table. Historical results carry
 *  it as a JSON string (only the invoke response re-parses it), so try both. */
function asTable(value) {
  let v = value;
  if (typeof v === 'string' && /^\s*[[{]/.test(v)) { try { v = JSON.parse(v); } catch { return null; } }
  if (!Array.isArray(v) || !v.length || typeof v[0] !== 'object' || v[0] === null) return null;
  const cols = [...new Set(v.flatMap((r) => Object.keys(r)))];
  const t = h('table', { class: 'data' });
  t.append(h('thead', {}, h('tr', {}, cols.map((c) => h('th', { text: c })))));
  t.append(h('tbody', {}, v.map((r) => h('tr', {}, cols.map((c) => h('td', { text: r[c] === undefined || r[c] === null ? '' : String(r[c]) }))))));
  return t;
}

const evUrl = (file) => `/api/runs/${encodeURIComponent(S.run.kind)}/${encodeURIComponent(S.run.runId)}/evidence/${file}`;

// ───────────────────────────── run history ─────────────────────────────

async function loadHistory() {
  const kind = $('history-kind').value;
  const box = $('history');
  try {
    const runs = await api(`/api/runs?limit=200${kind ? `&kind=${kind}` : ''}`);
    // The API sorts on `startedAt ?? runId` — two different formats — so a run
    // that HAS a start time sorts below one that doesn't. Re-sort on a single
    // normalized key here so "most recent" means most recent.
    runs.sort((a, b) => runOrder(b) - runOrder(a));
    runs.length = Math.min(runs.length, 40);
    clear(box);
    if (!runs.length) { box.append(emptyState('No runs yet', 'Invoke a capability to produce one.')); return; }
    for (const r of runs) {
      const row = h('button', { class: 'run-row' + (S.run && S.run.runId === r.runId ? ' is-active' : ''), type: 'button', 'data-run': r.runId,
        onclick: () => openRun(r.runId, r.kind) },
        h('span', { class: 'run-row-cap', text: r.capabilityId || r.runId }),
        pill(r.live ? 'running' : r.status),
        // "Recovered" is its own fact about a run: a success that took two
        // SESSION_EXPIRED restarts is not the same event as a clean one, and
        // the row used to be pixel-identical. The badge names the codes,
        // because which condition recurred is what says the app is drifting.
        recoveryBadge(r.recoveries),
        h('span', { class: 'run-row-meta' },
          h('span', { text: r.kind }),
          h('span', { text: r.runId }),
          r.startedAt ? h('span', { text: fmtWhen(r.startedAt) }) : null,
          typeof r.durationMs === 'number' ? h('span', { text: fmtMs(r.durationMs) }) : null,
          typeof r.stepsOk === 'number' ? h('span', { text: `${r.stepsOk} steps ok` }) : null,
          r.interventions ? h('span', { text: `${r.interventions} handoff(s)` }) : null,
        ));
      box.append(row);
    }
  } catch (err) {
    clear(box).append(emptyState('History unavailable', String(err.message)));
  }
}

/**
 * The "recovered" badge, from a summary's recovery list. Returns null when the
 * run recorded none — including runs whose evidence predates the field, which
 * is why an ABSENT list must read as "nothing to say" rather than "clean".
 */
function recoveryBadge(recoveries) {
  if (!Array.isArray(recoveries) || !recoveries.length) return null;
  const total = recoveries.reduce((n, r) => n + (Number(r.attempts) || 1), 0);
  const b = badge(`recovered ×${total}`, 'warn');
  b.title = recoveries.map((r) => `${r.code} ×${r.attempts}`).join(', ');
  return b;
}

/** One comparable key per run: its startedAt, else the timestamp its id encodes. */
function runOrder(r) {
  const t = Date.parse(r.startedAt || '');
  if (!isNaN(t)) return t;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(r.runId || '');
  return m ? +new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}

function markHistoryActive(runId) {
  for (const el of document.querySelectorAll('.run-row')) el.classList.toggle('is-active', el.dataset.run === runId);
}

// ───────────────────────────── interventions ─────────────────────────────

/** Poll for open interventions. Faster while one is open: the run is holding a
 *  live banking session while a human decides. */
async function pollInterventions() {
  let list = null;
  try {
    list = await api('/api/interventions');
    S.pollMisses = 0;
  } catch {
    // One miss is a hiccup and the last render still stands. A run of them is
    // not: the amber bar keeps a working-looking "Approve — let it post" on
    // screen indefinitely, over a session that is already gone. A control that
    // gates a money movement must never look live when it cannot act.
    S.pollMisses = (S.pollMisses || 0) + 1;
  }
  const bar = $('intervention-bar');
  const stale = S.pollMisses >= 3;
  bar.classList.toggle('is-stale', stale);
  for (const b of bar.querySelectorAll('button')) b.disabled = stale;
  if (list) renderInterventions(list);
  clearTimeout(S.pollTimer);
  S.pollTimer = setTimeout(pollInterventions, (list && list.length) ? 1000 : 2000);
}

function renderInterventions(list) {
  const bar = $('intervention-bar');
  // Key, not id: `int-01` is numbered per RUN, so two concurrent runs both
  // raise it and an id-keyed view collapses them into one card.
  const ids = list.map((i) => i.key).join(',');
  if (ids === S.lastInterventionIds) return;     // don't rebuild under the operator's cursor
  S.lastInterventionIds = ids;
  clear(bar);
  bar.hidden = list.length === 0;
  if (!list.length) return;

  for (const iv of list) {
    const shot = h('div', { class: 'iv-shot' });
    if (iv.screenshotUrl) {
      shot.append(h('img', { src: iv.screenshotUrl, alt: 'State at the moment of escalation', onerror: () => clear(shot).append(h('div', { class: 'shot-empty', text: 'screenshot unavailable' })) }));
      shot.addEventListener('click', () => lightbox(iv.screenshotUrl, iv.screenshotRef || 'intervention'));
    } else shot.append(h('div', { class: 'shot-empty', text: 'no screenshot' }));

    const actions = h('div', { class: 'iv-actions' });
    for (const opt of iv.options || []) {
      const cls = opt === 'approve' ? 'btn btn-warn' : opt === 'abort' ? 'btn btn-danger' : 'btn';
      actions.append(h('button', { class: cls, type: 'button', text: labelFor(opt), onclick: (e) => resolveIntervention(iv, opt, e.currentTarget) }));
    }
    actions.append(h('div', { class: 'iv-meta', text: `raised ${fmtClock(iv.raisedAt)}` }));
    actions.append(h('button', { class: 'mini-btn', type: 'button', text: 'Open this run', onclick: () => openRun(iv.runId, 'replay') }));

    bar.append(h('div', { class: 'iv' }, shot,
      h('div', { class: 'iv-main' },
        h('div', { class: 'iv-kicker' }, h('span', { class: 'dot-live' }), 'Human decision required',
          badge(iv.kind, 'warn'), badge(`${iv.capabilityId}@${iv.version}`), iv.stepId ? badge(`step ${iv.stepId}`) : null,
          iv.origin ? badge(`origin: ${iv.origin}`) : null),
        h('div', { class: 'iv-reason', text: iv.reason || 'The automation stopped and is waiting.' }),
        iv.stepIntent ? h('div', { class: 'iv-suggest', text: `Step intent: ${iv.stepIntent}` }) : null,
        h('div', { class: 'iv-suggest', text: iv.suggestedResolution || '' }),
        iv.observationSummary ? h('pre', { class: 'iv-obs', text: iv.observationSummary }) : null),
      actions));
  }
}

const labelFor = (opt) => ({ approve: 'Approve — let it post', abort: 'Abort the run', resume: 'Resume' }[opt] || opt);

/**
 * Resolve one intervention.
 *
 * The nonce is fetched HERE rather than read off the listing. What that buys:
 * the listing is an unauthenticated GET the console polls every second, so a
 * nonce carried on it is published to anything that can reach the port — and
 * the nonce is the last thing between an API call and money moving. What it
 * does NOT buy: authentication. Anything that can call this route can call the
 * nonce route too. The real boundary is the server's loopback bind plus its
 * Host check (which is what stops a DNS-rebound page); the nonce only stops a
 * blind POST from landing on an approval it never specifically asked for.
 */
async function resolveIntervention(iv, action, btn) {
  for (const b of btn.parentElement.querySelectorAll('button')) b.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const { nonce } = await api(`/api/interventions/${encodeURIComponent(iv.key)}/nonce`);
    const res = await api(`/api/interventions/${encodeURIComponent(iv.key)}/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, nonce, note: `Resolved from the operations console by an on-duty operator.` }),
    });
    if (res && res.ok) toast(`Intervention ${iv.id}: "${action}" accepted.`, 'ok');
    else toast(`Rejected: ${(res && res.error) || 'unknown error'}`, 'err');
  } catch (err) {
    toast(`Rejected: ${err.message}`, 'err');
  } finally {
    S.lastInterventionIds = null;   // force a rebuild on the next poll
    pollInterventions();
  }
}

// ───────────────────────────── evidence drawer ─────────────────────────────

function openEvidence() {
  const run = S.run; if (!run) return;
  const body = clear($('evidence-body'));
  const tabs = h('div', { class: 'tabs' });
  const pane = h('div', {});
  const views = {
    'Screenshots': () => {
      if (!run.shots.length) return emptyState('No screenshots', 'This run recorded no screenshot events.');
      const grid = h('div', { class: 'shot-grid' });
      for (const s of run.shots) grid.append(h('figure', { onclick: () => lightbox(s.url, s.file) },
        h('img', { src: s.url, alt: s.name }), h('figcaption', { text: `${s.file}\n${s.name}` })));
      return grid;
    },
    [`run.jsonl (${run.events.length} events)`]: () => {
      if (!run.events.length) return emptyState('No events', 'Nothing was recorded for this run.');
      const list = h('div', { class: 'ev-list' });
      for (const ev of run.events) list.append(h('pre', { class: 'ev-raw', text: JSON.stringify(ev) }));
      return list;
    },
    'Element maps': () => {
      const maps = run.elementMaps || [];
      if (!maps.length) {
        return emptyState('No element maps', 'This run predates per-observation element maps, or recorded none.');
      }
      const list = h('div', { class: 'ev-list' });
      list.append(h('div', { class: 'hint', style: 'margin-bottom:10px' },
        'What the locator ladder saw at each captured moment — the companion to the screenshots, and the artifact that explains a resolution or a refusal.'));
      for (const mp of maps) {
        list.append(h('button', { class: 'linkish', type: 'button', style: 'display:block;margin:4px 0',
          text: `${mp.file} — ${mp.count} elements`, onclick: () => openElementMap(mp.file) }));
      }
      return list;
    },
    'result.json': () => h('pre', { class: 'ev-raw', text: run.result ? JSON.stringify(run.result, null, 2) : 'No result document for this run.' }),
  };
  const select = (name) => {
    for (const t of tabs.children) t.classList.toggle('is-active', t.textContent === name);
    clear(pane).append(views[name]());
  };
  for (const name of Object.keys(views)) tabs.append(h('button', { class: 'tab', type: 'button', text: name, onclick: () => select(name) }));
  body.append(h('div', { class: 'hint', style: 'margin-bottom:14px' },
    `Audit trail for ${run.runId} — written by the run itself at `, h('span', { class: 'mono', text: (run.summary && run.summary.evidenceDir) || `evidence/${run.kind}/${run.runId}` }),
    '. Redaction is applied at the write boundary, so these bytes are what a reviewer sees.'), tabs, pane);
  select(Object.keys(views)[0]);
  $('evidence-modal').showModal();
}

function showRaw(title, ev) {
  const body = clear($('evidence-body'));
  body.append(h('div', { class: 'hint', style: 'margin-bottom:12px' }, `Raw event — ${title}`));
  body.append(h('pre', { class: 'ev-raw', text: JSON.stringify(ev, null, 2) }));
  $('evidence-modal').showModal();
}

function lightbox(url, caption) {
  $('lightbox-img').src = url;
  $('lightbox-caption').textContent = caption || '';
  $('lightbox').showModal();
}

function wireDialogs() {
  for (const btn of document.querySelectorAll('[data-close]')) btn.addEventListener('click', () => $(btn.dataset.close).close());
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });  // click the backdrop to dismiss
  }
}
