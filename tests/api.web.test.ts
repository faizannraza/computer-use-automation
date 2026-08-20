/**
 * The two static surfaces are served from one origin and link into each other,
 * so the CONTRACT BETWEEN THEM is testable even though neither runs here:
 * the URL shape the chat writes, and the fields it and the console read off
 * the API. There is no build step and no DOM in this suite, so these read the
 * shipped files and exercise the one expression that matters.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chat = readFileSync('web/chat/chat.js', 'utf8');
const dashboard = readFileSync('web/dashboard/app.js', 'utf8');

/** Source with its comments removed — a URL shape quoted in PROSE (including
 *  the one explaining the bug below) is documentation, not a link. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the chat → dashboard deep link opens the run', () => {
  it('writes a FRAGMENT, because the fragment is what the dashboard reads', () => {
    // The dashboard's deep link is `/#run=<id>&kind=<kind>`: it parses
    // location.hash at boot and rewrites it on every openRun.
    expect(dashboard).toContain('new URLSearchParams(location.hash.slice(1))');
    expect(dashboard).toContain('#run=${encodeURIComponent(runId)}&kind=');

    // The chat built `/?run=<id>` — a query string the dashboard never looks
    // at — so "Approve in the dashboard →", the one click the demo turns on,
    // landed the operator on an unopened console. Pull the real expression out
    // of the shipped file and run it, rather than asserting on its text.
    const expr = /a\.href = runId \? (.+?) : '\/';/.exec(chat)?.[1];
    expect(expr).toBeDefined();
    const href = new Function('runId', 'encodeURIComponent', `return ${expr};`)(
      '20260401-120000-abcd',
      encodeURIComponent,
    ) as string;

    const url = new URL(href, 'http://127.0.0.1:4180');
    expect(url.pathname).toBe('/'); // the dashboard, not a sub-page
    const params = new URLSearchParams(url.hash.slice(1)); // ...parsed the dashboard's way
    expect(params.get('run')).toBe('20260401-120000-abcd');
    expect(params.get('kind')).toBe('replay');
  });

  it('leaves no query-string deep link anywhere in the served files', () => {
    for (const source of [chat, dashboard]) expect(code(source)).not.toContain('?run=');
  });

  it('links to the console itself when there is no run to open', () => {
    expect(chat).toContain("a.href = runId ? '/#run='");
  });
});

/**
 * Field-level agreement with the API. Cheap, and it is what breaks silently:
 * a renamed payload field leaves the console rendering nothing at all, with no
 * error anywhere — the exact failure mode of the two defects below.
 */
describe('the console reads the fields the API actually serves', () => {
  it('renders broken capabilities from /api/profile’s catalog.broken', () => {
    // Broken artifacts ride on /api/profile rather than /api/capabilities,
    // which is an agent's tool list and must contain only callable entries
    // (see the comment on the profile route).
    expect(dashboard).toContain('S.profile.catalog.broken');
    expect(dashboard).toContain('is-broken');
    expect(readFileSync('web/dashboard/style.css', 'utf8')).toContain('.cap-card.is-broken');
  });

  it('renders the recovery badge from a run summary’s recoveries', () => {
    expect(dashboard).toContain('recoveryBadge(r.recoveries)');
    expect(dashboard).toContain('recoveryBadge((result && result.recoveriesUsed) || summary.recoveries)');
  });
});
