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

/* Not a markdown renderer — just enough to stop the model's **bold** and
   `code` reading as literal punctuation on a projector. Runs strictly AFTER
   escaping, so no author-controlled markup can survive. */
function lightFormat(text) {
  return esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
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

/** A link into the dashboard, on the run when we know it. Always a new tab. */
function dashLink(className, html, runId) {
  var a = el('a', className, html);
  a.href = runId ? '/?run=' + encodeURIComponent(runId) : '/';
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
 * Chips are derived from the live catalog, never hard-coded blind: each
 * template is kept only if a capability whose name matches actually exists,
 * and the example values come from the capability's own inputSchema.
 */
function renderChips() {
  var templates = [
    { match: /balance/i,                text: function (c) { return 'What is the savings balance for member ' + ex(c, 'memberId', '12345') + '?'; } },
    { match: /transfer/i,               text: function (c) { return 'Transfer $' + ex(c, 'amount', '50.00') + ' from ' + ex(c, 'fromShare', 'S0001') + ' to ' + ex(c, 'toShare', 'S0070'); } },
    { match: /inquire|search|lookup/i,  text: function (c) { return 'Look up member ' + ex(c, 'memberId', '12345'); } },
    { match: /hold/i,                   text: function (c) { return 'Place a hold on member ' + ex(c, 'memberId', '12345'); } },
    { match: /subaccount|openaccount/i, text: function (c) { return 'Open a ' + ex(c, 'acctType', 'HOLIDAY CLUB') + ' sub-account for member ' + ex(c, 'memberId', '12345') + ' called "' + ex(c, 'nickname', 'Vacation Fund') + '" with $' + ex(c, 'initialDeposit', '50.00'); } }
  ];

  var chips = [];
  templates.forEach(function (t) {
    var cap = capabilities.find(function (c) { return t.match.test(c.name); });
    if (cap) chips.push({ text: t.text(cap), risk: cap.maxRisk });
  });

  // The negative path is worth showing: a declared business outcome is an
  // answer, not a crash. Use an id that is well-formed but cannot exist.
  var readOnly = capabilities.find(function (c) { return c.maxRisk !== 'irreversible'; });
  if (readOnly) chips.push({ text: 'Look up member 999999', risk: readOnly.maxRisk });
  if (!chips.length) chips = [{ text: 'What can you do?', risk: null }];

  $chips.innerHTML = '';
  chips.slice(0, 4).forEach(function (chip) {
    var btn = el('button', 'chip');
    btn.type = 'button';
    btn.textContent = chip.text;
    if (chip.risk === 'irreversible') {
      btn.appendChild(el('span', 'risk risk-irreversible', 'needs approval'));
      btn.title = 'This capability pauses for a human before it posts.';
    }
    btn.addEventListener('click', function () {
      if (busy) return;
      $input.value = chip.text;
      grow();
      submit();
    });
    $chips.appendChild(btn);
  });
}

/** Pull an example value for a field out of the capability's inputSchema. */
function ex(cap, field, fallback) {
  var props = (cap.inputSchema && cap.inputSchema.properties) || {};
  var spec = props[field];
  if (spec) {
    if (Array.isArray(spec.examples) && spec.examples.length) return String(spec.examples[0]);
    if (Array.isArray(spec.enum) && spec.enum.length) return String(spec.enum[0]);
  }
  return fallback;
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
  if (data.mode) {
    showMode(data.mode);
    syncModeButtons(data.mode);
  }

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

var ATTENTION = { awaiting_approval: 1, escalated: 1 };
var BAD = { failed: 1, error: 1, rejected: 1 };

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
  actions.appendChild(dashLink('ap-btn', 'Approve in the dashboard &rarr;', iv.runId));
  actions.appendChild(status);
  box.appendChild(actions);
  add(box);

  approvals[id] = { el: box, status: status, title: title, runId: iv.runId || null,
                    resolved: false, seen: false, since: Date.now() };
  return approvals[id];
}

function markResolved(id) {
  var entry = approvals[id];
  if (!entry || entry.resolved) return;
  entry.resolved = true;
  entry.el.classList.add('is-resolved');
  entry.title.textContent = 'Approved — the run is continuing';
  entry.status.textContent = 'resolved in the dashboard';
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
  try { open = await getJson('/api/interventions'); } catch { return; }
  if (!Array.isArray(open)) return;

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
   labelling ("deterministic planner / no model"). */
function showMode(mode) {
  $modeState.textContent = 'mode: ' + mode + (forcedMode ? ' (forced)' : ' (auto)');
}

function syncModeButtons(active) {
  Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), function (btn) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === active));
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
    forcedMode = btn.dataset.mode;
    syncModeButtons(forcedMode);
    showMode(forcedMode);
  });
});

boot();
