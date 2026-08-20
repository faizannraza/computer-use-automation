/*
 * Capability Console — chat front end.
 *
 * A thin driver over the API. It holds the whole conversation in the page
 * (the server keeps no state, so every turn re-sends the messages) and its real
 * job is to make one thing visible: the assistant is not typing into a UI, it
 * is invoking recorded capabilities, and some of them stop for a human.
 *
 * No build step, no framework, no network beyond this origin.
 */
'use strict';

// ---------------------------------------------------------------- state

var messages = [];         // [{role, content}] — sent in full every turn
var capabilities = [];     // from /api/capabilities
var forcedMode = null;     // 'llm' | 'scripted' | null (let the server decide)
var serverMode = null;     // the mode the server actually ran, last time it said
var busy = false;
var pollTimer = null;
var approvals = {};        // banner key -> { el, status, title, runId, resolved, seen, since }
var GRACE_MS = 6000;       // how long an unconfirmed banner may sit before we call it resolved

var $transcript = document.getElementById('transcript');
var $input = document.getElementById('input');
var $send = document.getElementById('send');
var $chips = document.getElementById('chips');
var $modeState = document.getElementById('mode-state');

// ------------------------------------------------------------- helpers

/** Everything that reaches the DOM as markup goes through here first. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Inline marks only. Runs strictly AFTER escaping, so no author-controlled
   markup can survive — the reply is model text quoting a banking screen. */
function inlineFormat(text) {
  return esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

var TABLE_ROW = /^\s*\|.*\|\s*$/;
var TABLE_RULE = /^\s*\|[\s:|-]*-[\s:|-]*\|\s*$/;

/**
 * Still not a markdown renderer — inline marks, plus the one BLOCK the planner
 * reliably produces: a pipe table.
 *
 * Several capabilities return a `table` output (shares, search matches), and
 * asked for one the model answers with `| Share ID | Type | Balance |` and a
 * `|---|---|` rule. `.bubble` is `white-space: pre-wrap` in a proportional
 * face, so those rows landed on the projector as unaligned literal pipes —
 * on the one chip whose entire point is "this comes back as a table".
 *
 * Cells go through `inlineFormat`, i.e. through `esc`, before any tag is
 * built, so screen text that contains markup is still inert.
 */
function lightFormat(text) {
  var lines = String(text == null ? '' : text).split('\n');
  var out = [];
  var buf = [];
  function flush() {
    var block = buf.join('\n').replace(/^\n+|\n+$/g, '');
    buf = [];
    if (block) out.push(inlineFormat(block));
  }
  for (var i = 0; i < lines.length; i++) {
    if (TABLE_ROW.test(lines[i]) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      flush();
      var head = tableCells(lines[i]);
      var body = [];
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++) body.push(tableCells(lines[i]));
      i--;                                     // the loop's own i++ takes the next line
      out.push(renderTable(head, body));
    } else {
      buf.push(lines[i]);
    }
  }
  flush();
  return out.join('\n');
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
}

function renderTable(head, body) {
  var cell = function (tag, text) { return '<' + tag + '>' + inlineFormat(text) + '</' + tag + '>'; };
  var row = function (tag, cells) {
    return '<tr>' + cells.map(function (c) { return cell(tag, c); }).join('') + '</tr>';
  };
  return '<div class="md-table"><table>' +
         '<thead>' + row('th', head) + '</thead>' +
         '<tbody>' + body.map(function (r) { return row('td', r); }).join('') + '</tbody>' +
         '</table></div>';
}

function el(tag, className, html) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

function add(node) {
  $transcript.appendChild(node);
  scrollDown();
  return node;
}

/**
 * A link into the dashboard, on the run when we know it. Always a new tab.
 *
 * The FRAGMENT is the dashboard's deep link (`/#run=<id>&kind=replay`) — it
 * reads `location.hash` at boot and rewrites it on every openRun. This used to
 * build a query string (`/?run=<id>`), which the dashboard never looks at, so
 * "Approve in the dashboard →" — the one click the demo turns on — landed the
 * operator on an unopened console with the parked run nowhere in sight.
 */
function dashLink(className, html, runId) {
  var a = el('a', className, html);
  a.href = runId ? '/#run=' + encodeURIComponent(runId) + '&kind=replay' : '/';
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

function scrollDown() {
  var stage = document.querySelector('.stage');
  stage.scrollTop = stage.scrollHeight;
}

function notice(html) { add(el('div', 'notice', html)); }

async function getJson(path) {
  var res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
  return res.json();
}

// --------------------------------------------------------------- boot

async function boot() {
  // Both are optional decoration — a failure here must not break chatting.
  var profile = null;
  try { profile = await getJson('/api/profile'); } catch { /* header stays generic */ }
  try { capabilities = await getJson('/api/capabilities'); } catch { capabilities = []; }

  if (profile) {
    document.getElementById('app-title').textContent = profile.title || 'Capability Console';
    document.getElementById('app-base').textContent = profile.baseUrl || '';
    document.getElementById('foot-base').textContent = profile.title || 'the target application';
    document.title = (profile.vendor || 'Capability') + ' — Chat';
  }
  document.getElementById('cap-count').textContent =
    capabilities.length + (capabilities.length === 1 ? ' capability' : ' capabilities');

  renderIntro(profile);
  renderChips();
}

function renderIntro(profile) {
  var intro = el('div', 'intro');
  intro.appendChild(el('h2', null, 'Ask for an outcome, not a click path.'));
  intro.appendChild(el('p', null,
    'I work only through reviewed, recorded capabilities against ' +
    esc(profile ? profile.title : 'the target application') +
    '. Anything irreversible stops for a human before it posts.'));

  if (capabilities.length) {
    var list = el('ul');
    capabilities.forEach(function (cap) {
      list.appendChild(el('li', null,
        '<b>' + esc(cap.name) + '</b><span>' + esc(cap.title || '') + '</span>' +
        '<span class="risk ' + riskClass(cap.maxRisk) + '">' + esc(cap.maxRisk || '') + '</span>'));
    });
    intro.appendChild(list);
  }
  add(intro);
}

function riskClass(risk) {
  return risk === 'irreversible' ? 'risk-irreversible'
       : risk === 'reversible' ? 'risk-reversible' : 'risk-readonly';
}

// ------------------------------------------------- suggested prompts

/**
 * Four prompts in the order they tell the story: a clean read, a search that
 * comes back as a table, a declared business outcome, and the one that parks on
 * a human.
 *
 * The IDENTIFIERS are pinned to live records rather than derived from each
 * capability's `inputSchema` examples. An artifact's examples are whatever was
 * on screen when it was RECORDED, and they go stale: the generated chips
 * offered `member 12345` (a MockCore id that does not exist on this host) and
 * `101555-S0001 → 101555-CERT` (two shares now on HOLD, which the app refuses).
 * A suggestion that cannot succeed is worse than no suggestion, and these are
 * the first words the room reads.
 *
 * Still gated on the catalog, which is the part that was worth keeping: a chip
 * appears only if its capability is actually loaded, so a deployment missing
 * one shows three chips rather than a button that 404s. The risk tag is read
 * off the capability too, never asserted here.
 *
 * These values are checked against the live host before a demo; re-check with
 * `member.readBalances` on 103001, because the shares are shared state and a
 * HOLD can appear between one run and the next.
 */
var CHIP_SPECS = [
  { cap: 'member.readBalances', text: 'What are the balances for member 103001?' },
  { cap: 'member.inquire', text: 'Find members with the last name Lovelace' },
  {
    cap: 'member.inquire',
    text: 'Look up member 999999',
    // Labelled, because an unlabelled "not found" on a projector reads as the
    // demo breaking. It is a declared outcome the capability handles.
    note: 'expected: not found',
    title: 'MEMBER_NOT_FOUND is a business outcome the capability declares and handles — a result, not an error.'
  },
  { cap: 'member.transferFunds', text: 'Transfer $1.00 from 103001-S0070-7 to 103001-MMKT-8' }
];

function renderChips() {
  var chips = [];
  CHIP_SPECS.forEach(function (spec) {
    var cap = capabilities.find(function (c) { return c.name === spec.cap; });
    if (cap) chips.push({ text: spec.text, risk: cap.maxRisk, note: spec.note, title: spec.title });
  });
  if (!chips.length) chips = [{ text: 'What can you do?' }];

  $chips.innerHTML = '';
  chips.forEach(function (chip) {
    var btn = el('button', 'chip');
    btn.type = 'button';
    btn.textContent = chip.text;
    if (chip.risk === 'irreversible') {
      btn.appendChild(el('span', 'risk risk-irreversible', 'needs approval'));
      btn.title = 'This capability pauses for a human before it posts.';
    } else if (chip.note) {
      btn.appendChild(el('span', 'risk risk-outcome', esc(chip.note)));
    }
    if (chip.title) btn.title = chip.title;
    btn.addEventListener('click', function () {
      if (busy) return;
      $input.value = chip.text;
      grow();
      submit();
    });
    $chips.appendChild(btn);
  });
}

// ------------------------------------------------------------ the turn

function submit() {
  var text = $input.value.trim();
  if (!text || busy) return;

  $input.value = '';
  grow();
  addMessage('user', text);
  messages.push({ role: 'user', content: text });
  runTurn();
}

function addMessage(role, text) {
  var wrap = el('div', 'msg ' + role);
  wrap.appendChild(el('div', 'bubble', lightFormat(text)));
  add(wrap);
}

async function runTurn() {
  setBusy(true);
  var working = addWorking();
  startPolling();          // an approval may surface mid-turn, before the reply

  var body = { messages: messages };
  if (forcedMode) body.mode = forcedMode;

  try {
    var res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      var detail = await res.text().catch(function () { return ''; });
      notice('The API returned <b>HTTP ' + res.status + '</b>. ' +
             (detail ? esc(detail.slice(0, 300)) : 'No detail was provided.'));
      return;
    }
    renderTurn(await res.json());
  } catch (err) {
    notice('<b>Could not reach the API.</b> ' + esc(err && err.message ? err.message : String(err)) +
           ' — the operator service on this origin may not be running.');
  } finally {
    working.remove();      // also clears its elapsed-seconds interval
    setBusy(false);
    // Keep polling only while something is still parked on a human.
    if (!hasOpenApproval()) stopPolling();
  }
}

function renderTurn(data) {
  if (data.mode) serverMode = data.mode;
  showMode();
  syncModeButtons();

  (data.toolCalls || []).forEach(renderToolCall);

  var reply = (data.reply || '').trim();
  if (reply) {
    addMessage('assistant', reply);
    messages.push({ role: 'assistant', content: reply });
  } else if (!(data.toolCalls || []).length) {
    notice('The planner returned an empty reply and invoked nothing. Try rephrasing, ' +
           'or switch planner mode.');
  }
  scrollDown();
}

// ------------------------------------------------- tool call rendering

var ATTENTION = { awaiting_approval: 1, escalated: 1, still_running: 1 };
var BAD = { failed: 1, error: 1, refused: 1 };

function renderToolCall(call) {
  var status = call.status || 'unknown';
  var tone = ATTENTION[status] ? 'is-attention' : BAD[status] ? 'is-bad' : status === 'success' ? 'is-ok' : '';
  var card = el('div', 'toolcard ' + tone);

  card.appendChild(el('div', 'tc-head',
    '<span class="tc-kicker">capability invoked</span>' +
    '<span class="tc-name">' + esc(call.name || '(unnamed)') + '</span>' +
    '<span class="pill s-' + esc(status) + '">' + esc(status.replace(/_/g, ' ')) + '</span>'));

  var body = el('div', 'tc-body');
  body.appendChild(renderArgs(call.input));
  if (call.summary) body.appendChild(el('div', 'tc-summary', esc(call.summary)));
  card.appendChild(body);

  if (call.runId) {
    var foot = el('div', 'tc-foot', '<span class="tc-runid">run ' + esc(call.runId) + '</span>');
    foot.appendChild(dashLink('tc-link', 'view run &rarr;', call.runId));
    card.appendChild(foot);
  }
  add(card);

  // The moment the demo is about. If the run parked on a human, say so loudly
  // and keep watching until it moves.
  if (status === 'awaiting_approval') {
    ensureApprovalBanner({ runId: call.runId, reason: call.summary, id: 'call:' + call.runId });
    startPolling();
  }
}

/** The typed arguments, so the room can see a schema was satisfied. */
function renderArgs(input) {
  var keys = input && typeof input === 'object' ? Object.keys(input) : [];
  if (!keys.length) return el('dl', 'args', '<span class="none">no arguments</span>');
  return el('dl', 'args', keys.map(function (key) {
    var v = input[key];
    return '<dt>' + esc(key) + '</dt><dd>' +
           esc(typeof v === 'object' ? JSON.stringify(v) : v) + '</dd>';
  }).join(''));
}

// ------------------------------------------------- approval + polling

function hasOpenApproval() {
  return Object.keys(approvals).some(function (id) { return !approvals[id].resolved; });
}

/* One banner per parked RUN. We can learn about the same pause twice — from
   the poll (which knows the intervention id) and from the turn's toolCall
   (which only knows the run) — so dedupe on id, then on runId. */
function ensureApprovalBanner(iv) {
  var id = iv.id;
  if (approvals[id]) return approvals[id];
  var byRun = iv.runId && Object.keys(approvals).find(function (k) {
    return approvals[k].runId === iv.runId;
  });
  if (byRun) return approvals[byRun];

  var box = el('div', 'approval');
  var head = el('div', 'ap-head');
  head.appendChild(el('span', 'ap-dot'));
  var title = el('span', 'ap-title', 'Paused — waiting for a human');
  head.appendChild(title);
  box.appendChild(head);

  box.appendChild(el('p', 'ap-reason',
    'This run reached a step the policy will not let an agent take on its own. ' +
    (iv.reason ? '<b>' + esc(iv.reason) + '</b>' : 'It is holding until someone approves or rejects it.') +
    (iv.suggestedResolution ? ' Suggested: <b>' + esc(iv.suggestedResolution) + '</b>.' : '')));

  var meta = el('div', 'ap-meta');
  [iv.runId && 'run ' + iv.runId, iv.capabilityId, iv.kind,
   (iv.options || []).length && 'options: ' + iv.options.join(' / ')]
    .forEach(function (bit) { if (bit) meta.appendChild(el('span', null, esc(bit))); });
  box.appendChild(meta);

  var actions = el('div', 'ap-actions');
  var status = el('span', 'ap-status', 'still waiting…');
  var button = dashLink('ap-btn', 'Approve in the dashboard &rarr;', iv.runId);
  actions.appendChild(button);
  actions.appendChild(status);
  box.appendChild(actions);
  add(box);

  approvals[id] = { el: box, status: status, title: title, button: button, runId: iv.runId || null,
                    resolved: false, seen: false, since: Date.now() };
  return approvals[id];
}

/* A run that has just been resolved needs a moment to write its result, so the
   banner says it is reading rather than guessing during this window. */
var SETTLE_GRACE_MS = 6000;
/* Bounded: a run this page can no longer learn anything about must not leave
   it polling for the rest of the session. Longer than the 180s intervention
   timeout, because an APPROVED run's remaining steps start after it. */
var WATCH_MS = 300000;

/**
 * The intervention left the open list. Report what actually happened — by
 * asking the run, which is the only thing that knows.
 *
 * Leaving that list means one of three things: a human approved it, a human
 * rejected it, or nobody answered and the 180s timeout aborted it on their
 * behalf. All three are indistinguishable from `/api/interventions`, which
 * only ever says "not open any more". Hardcoding "Approved — the run is
 * continuing" therefore announced an authorised transfer to the room in the
 * two cases where the transfer had in fact been refused and nothing posted —
 * the single most damaging sentence this UI could get wrong, and not one the
 * audience can catch, because they read the banner rather than the run.
 */
function markResolved(id) {
  var entry = approvals[id];
  if (!entry || entry.resolved) return;
  entry.resolved = true;                // set first: the 2s poll re-enters here
  entry.resolvedAt = Date.now();
  entry.el.classList.add('is-resolved');
  entry.title.textContent = 'No longer waiting for a human';
  entry.status.textContent = 'reading the run…';
  // The one action this banner offered was "Approve", and the moment the
  // intervention closed there was nothing left to approve.
  entry.button.innerHTML = 'View the run &rarr;';
  watchRun(entry);
}

/**
 * Follow a resolved run to a terminal state, restating the banner as it moves.
 *
 * An approval is the START of the rest of the run, not the end of it: "a human
 * approved this" and "this posted" are different claims, and the second one is
 * the one the room actually wants. So the banner keeps reporting until the run
 * reaches a status.
 */
async function watchRun(entry) {
  if (!entry.runId) {
    entry.status.textContent = 'this run is not identified here — the dashboard has the outcome';
    return;
  }
  var until = Date.now() + WATCH_MS;
  for (;;) {
    var outcome = await runOutcome(entry);
    entry.title.textContent = outcome.title;
    entry.status.textContent = outcome.detail;
    // Assigned rather than added, so a run that reports "continuing" and then
    // fails does not end up wearing both colours.
    entry.el.className = 'approval is-resolved' + (outcome.tone ? ' ' + outcome.tone : '');
    if (outcome.settled || Date.now() > until) return;
    await wait(2000);
  }
}

/**
 * What the run says about itself, in the words the banner will use.
 *
 * `result` is the run's own written outcome and is authoritative; `summary`
 * covers the window before it exists. Both are consulted because they settle
 * at different moments — the result file is written the instant the engine
 * halts, the summary only once the browser has closed behind it.
 */
async function runOutcome(entry) {
  var detail;
  try {
    detail = await getJson('/api/runs/' + encodeURIComponent(entry.runId));
  } catch (err) {
    return { settled: true, tone: '', title: 'No longer waiting for a human',
             detail: 'could not read the run (' + (err && err.message ? err.message : err) + ')' };
  }
  var result = detail.result || null;
  var status = (result && result.status) || (detail.summary && detail.summary.status) || 'unknown';

  // Aborted, or timed out — either way the run STOPPED at the gate and the
  // irreversible step never ran. The note is what separates the two: a human
  // who said no, versus a human who never came.
  if (status === 'escalated') {
    var timedOut = (result && result.interventions || []).some(function (i) {
      return typeof i.note === 'string' && /no operator resolved this within/i.test(i.note);
    });
    return {
      settled: true,
      tone: 'is-stopped',
      title: timedOut ? 'Timed out — the run stopped, nothing posted' : 'Rejected — the run stopped, nothing posted',
      detail: timedOut ? 'no one resolved it in time; the run aborted rather than hold a live banking session open'
                       : 'aborted by a human at the approval gate'
    };
  }
  if (status === 'success') {
    return { settled: true, tone: 'is-approved', title: 'Approved — the run completed',
             detail: 'the approved step ran and the run finished' };
  }
  if (status === 'business_outcome') {
    return { settled: true, tone: 'is-approved', title: 'Approved — the run finished with a business outcome',
             detail: (result && result.code ? result.code : 'business outcome') + ' — a declared answer, not a failure' };
  }
  if (status === 'failed') {
    var f = (result && result.failure) || {};
    return { settled: true, tone: 'is-stopped', title: 'Approved, then the run failed',
             detail: (f.class || 'failed') + (f.stepId ? ' at ' + f.stepId : '') };
  }
  if (status === 'error') {
    return { settled: true, tone: 'is-stopped', title: 'The run ended in an error',
             detail: 'see the run in the dashboard' };
  }

  // Still running. Immediately after a resolution that is ambiguous — an abort
  // has not finished writing its result yet — so say nothing about approval
  // until the grace window has passed.
  var waited = Date.now() - entry.resolvedAt;
  if (waited < SETTLE_GRACE_MS) {
    return { settled: false, tone: '', title: 'No longer waiting for a human',
             detail: 'reading the run…' };
  }
  return { settled: false, tone: 'is-approved', title: 'Approved — the run is continuing',
           detail: 'running for ' + Math.round(waited / 1000) + 's since the approval' };
}

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function startPolling() {
  if (pollTimer) return;
  pollInterventions();                       // don't wait 2s for the first look
  pollTimer = setInterval(pollInterventions, 2000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/* Every 2s: which runs are still parked? Anything in the list gets (or keeps)
   a banner; anything whose banner is showing but which has left the list has
   been resolved by a human, so we say so instead of a stale "waiting". */
async function pollInterventions() {
  var open;
  // A failed or malformed read must still fall through to the stop check
  // below. Returning early skipped it, so one bad fetch while nothing was
  // parked left a 2s interval firing for the rest of the session — a failing
  // request every two seconds behind a demo, and the "still waiting — Ns"
  // clock on every banner frozen at whatever it last read.
  try { open = await getJson('/api/interventions'); } catch { open = null; }
  if (!Array.isArray(open)) {
    if (!busy && !hasOpenApproval()) stopPolling();
    return;
  }

  var liveRuns = {}, liveIds = {};
  open.forEach(function (iv) {
    // Dedupe on the server's globally unique key: `id` is numbered per RUN
    // (`int-01`), so two parked runs would otherwise share one banner.
    iv.id = iv.key || iv.id || ('run:' + iv.runId);
    if (iv.runId) liveRuns[iv.runId] = true;
    liveIds[iv.id] = true;
    var entry = ensureApprovalBanner(iv);
    entry.seen = true;
    if (!entry.resolved) {
      entry.status.textContent = 'still waiting — ' + Math.round((Date.now() - entry.since) / 1000) + 's';
    }
  });

  // Absent from the list = a human acted on it. A banner raised from a
  // toolCall has not been poll-confirmed yet, so give it a grace window
  // rather than declaring it approved on the first (possibly racing) fetch.
  Object.keys(approvals).forEach(function (id) {
    var entry = approvals[id];
    if (liveIds[id] || (entry.runId && liveRuns[entry.runId])) return;
    if (entry.seen || Date.now() - entry.since > GRACE_MS) markResolved(id);
  });

  if (!busy && !hasOpenApproval()) stopPolling();
}

// ---------------------------------------------------------- chrome bits

function addWorking() {
  var box = el('div', 'working',
    '<span class="spinner"></span><span>Working — planning and invoking capabilities</span>');
  var elapsed = el('span', 'elapsed', '0s');
  box.appendChild(elapsed);
  add(box);

  // Turns can drive a real browser; 30-120s is normal, so show the clock.
  var t0 = Date.now();
  var tick = setInterval(function () {
    elapsed.textContent = Math.round((Date.now() - t0) / 1000) + 's';
  }, 1000);
  var kill = box.remove.bind(box);
  box.remove = function () { clearInterval(tick); kill(); };
  return box;
}

function setBusy(value) {
  busy = value;
  $input.disabled = value;
  $send.disabled = value;
  $send.textContent = value ? 'Working…' : 'Send';
  Array.prototype.forEach.call($chips.children, function (c) { c.disabled = value; });
  if (!value) $input.focus();
}

/* Terse for the header strip — the toggle buttons carry the full, honest
   labelling ("deterministic planner / no model"). Reads the state rather than
   taking it, so un-pinning falls back to the last mode the SERVER chose
   instead of printing "auto (auto)". */
function showMode() {
  var mode = forcedMode || serverMode;
  $modeState.textContent = forcedMode ? 'mode: ' + mode + ' (forced)'
    : mode ? 'mode: ' + mode + ' (auto)'
    : 'mode: auto';
}

/* Only a FORCED mode lights a button. The lit segment means "I pinned this",
   which is a claim the presenter is making; the server's own auto choice is
   reported in the header strip instead. Lighting a button for it read as a
   pinned mode that the next turn could silently change. */
function syncModeButtons() {
  Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), function (btn) {
    btn.setAttribute('aria-pressed', String(forcedMode !== null && btn.dataset.mode === forcedMode));
  });
}

/** Grow the textarea with its content, up to the CSS max-height. */
function grow() {
  $input.style.height = 'auto';
  $input.style.height = Math.min($input.scrollHeight, 190) + 'px';
}

// --------------------------------------------------------------- wiring

document.getElementById('composer').addEventListener('submit', function (e) {
  e.preventDefault(); submit();
});
$input.addEventListener('input', grow);
$input.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
});

Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), function (btn) {
  btn.setAttribute('aria-pressed', 'false');
  btn.addEventListener('click', function () {
    // Clicking the pinned mode UN-pins it. Without this the pair was one-way:
    // once a presenter pinned a planner there was no control anywhere on the
    // page that returned to auto, and clicking the lit button did nothing at
    // all — a dead control in the header of a live demo.
    forcedMode = forcedMode === btn.dataset.mode ? null : btn.dataset.mode;
    syncModeButtons();
    showMode();
  });
});

boot();
