/**
 * Smoke tests for the mock credit-union target app: both business flows and
 * every injectable fault. These prove the "stage" is deterministic before
 * any automation is built on top of it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../apps/mock-cu/server.js';

let server: Server;
let base: string;

/** Tiny HTTP client with cookie jar + form encoding (fetch keeps no state). */
class Client {
  private cookie = '';

  async get(path: string): Promise<Response> {
    const res = await fetch(base + path, { redirect: 'manual', headers: this.headers() });
    this.capture(res);
    return res;
  }

  async postForm(path: string, form: Record<string, string>): Promise<Response> {
    const res = await fetch(base + path, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...this.headers(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    this.capture(res);
    return res;
  }

  async login(): Promise<void> {
    const res = await this.postForm('/login', { txtUser: 'teller1', txtPass: 'Passw0rd!' });
    expect(res.status).toBe(302);
  }

  private headers(): Record<string, string> {
    return this.cookie ? { cookie: this.cookie } : {};
  }

  private capture(res: Response): void {
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
  }
}

async function setFault(fault: string, mode: string, param?: number): Promise<void> {
  const res = await fetch(`${base}/__faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fault, mode, param }),
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(async () => {
  await fetch(`${base}/__reset`, { method: 'POST' });
});

describe('auth', () => {
  it('redirects unauthenticated visitors to the sign-in screen', async () => {
    const c = new Client();
    const res = await c.get('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('rejects bad credentials', async () => {
    const c = new Client();
    const res = await c.postForm('/login', { txtUser: 'teller1', txtPass: 'wrong' });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Invalid operator ID or password.');
  });

  it('signs in and serves the frameset shell', async () => {
    const c = new Client();
    await c.login();
    const res = await c.get('/');
    const html = await res.text();
    expect(html).toContain('<frameset');
    expect(html).toContain('name="work"');
  });
});

describe('member lookup flow', () => {
  it('finds member 12345 and shows the savings balance on the detail screen', async () => {
    const c = new Client();
    await c.login();
    const results = await (await c.postForm('/members/search', { txtQuery: '12345' })).text();
    expect(results).toContain('Alexis Testmember');
    const detail = await (await c.get('/members/12345')).text();
    expect(detail).toContain('REGULAR SAVINGS');
    expect(detail).toContain('$4,821.97');
  });

  it('reports "no members matched" for an unknown member', async () => {
    const c = new Client();
    await c.login();
    const results = await (await c.postForm('/members/search', { txtQuery: '99999' })).text();
    expect(results).toContain('No members matched your search.');
  });

  it('404s a direct navigation to a nonexistent member', async () => {
    const c = new Client();
    await c.login();
    const res = await c.get('/members/99999');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('MBR-4041');
  });
});

describe('open sub-account flow', () => {
  const good = { cmbType: 'HOLIDAY CLUB', txtNickname: 'Vacation Fund', txtDeposit: '50.00' };

  it('validates input and re-renders the form with errors', async () => {
    const c = new Client();
    await c.login();
    const res = await c.postForm('/members/12345/subaccounts/review', { ...good, txtDeposit: '5' });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Initial deposit must be at least $25.00.');
  });

  it('walks form → review → confirm → confirmation screen', async () => {
    const c = new Client();
    await c.login();
    const review = await (await c.postForm('/members/12345/subaccounts/review', good)).text();
    expect(review).toContain('Please Verify Before Confirming');
    const confirm = await c.postForm('/members/12345/subaccounts/confirm', good);
    expect(confirm.status).toBe(302);
    const loc = confirm.headers.get('location')!;
    expect(loc).toContain('/subaccounts/confirmation?sfx=S02');
    const done = await (await c.get(loc)).text();
    expect(done).toContain('Sub-Account Opened Successfully');
    expect(done).toContain('Vacation Fund');
    expect(done).toContain('$50.00');
  });

  it('__reset restores the seed data', async () => {
    const c = new Client();
    await c.login();
    await c.postForm('/members/12345/subaccounts/confirm', good);
    await fetch(`${base}/__reset`, { method: 'POST' });
    const detail = await (await c.get('/members/12345')).text();
    expect(detail).not.toContain('Vacation Fund');
  });
});

describe('fault injection', () => {
  it('session_timeout: expires the session once, then normal service resumes after re-login', async () => {
    const c = new Client();
    await c.login();
    await setFault('session_timeout', 'once');
    const res = await c.get('/home');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?expired=1');
    const loginPage = await (await c.get('/login?expired=1')).text();
    expect(loginPage).toContain('Your session has expired.');
    await c.login();
    const home = await c.get('/home');
    expect(home.status).toBe(200);
  });

  it('permission_denied: confirm requires supervisor PIN; wrong PIN rejected; right PIN proceeds', async () => {
    const c = new Client();
    await c.login();
    await setFault('permission_denied', 'once');
    const good = { cmbType: 'CHECKING', txtNickname: 'Second Checking', txtDeposit: '100' };
    const denied = await c.postForm('/members/12345/subaccounts/confirm', good);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain('Supervisor Authorization Required (Code: PRM-4031)');
    const bad = await c.postForm('/members/12345/subaccounts/override', { ...good, txtPin: '0000' });
    expect(await bad.text()).toContain('Invalid supervisor PIN.');
    const ok = await c.postForm('/members/12345/subaccounts/override', { ...good, txtPin: '7391' });
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toContain('/subaccounts/confirmation');
  });

  it('interstitial: a notice page intercepts one GET, Continue leads back to the requested screen', async () => {
    const c = new Client();
    await c.login();
    await setFault('interstitial', 'once');
    const notice = await (await c.get('/members/search')).text();
    expect(notice).toContain('System Notice');
    expect(notice).toContain('href="/members/search"');
    const real = await (await c.get('/members/search')).text();
    expect(real).toContain('Member No. or Name');
  });

  it('duplicate_button: renders two identical Search buttons (locator-ambiguity trap)', async () => {
    const c = new Client();
    await c.login();
    await setFault('duplicate_button', 'on');
    const html = await (await c.get('/members/search')).text();
    expect(html.match(/value="Search"/g)).toHaveLength(2);
    await setFault('duplicate_button', 'off');
  });

  it('slow_load: delays the next request by the configured amount', async () => {
    const c = new Client();
    await c.login();
    await setFault('slow_load', 'once', 300);
    const t0 = Date.now();
    await c.get('/home');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
  });

  it('app_error: one request 500s, the next succeeds', async () => {
    const c = new Client();
    await c.login();
    await setFault('app_error', 'once');
    const err = await c.get('/home');
    expect(err.status).toBe(500);
    expect(await err.text()).toContain('ERR-5000');
    const ok = await c.get('/home');
    expect(ok.status).toBe(200);
  });

  it('native_dialog: the next screen fires a confirm() on load', async () => {
    const c = new Client();
    await c.login();
    await setFault('native_dialog', 'once');
    const html = await (await c.get('/home')).text();
    expect(html).toContain('window.confirm(');
    const clean = await (await c.get('/home')).text();
    expect(clean).not.toContain('window.confirm(');
  });
});
