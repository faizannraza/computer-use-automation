/**
 * MockCore Teller — an intentionally legacy-hostile mock credit-union
 * back office. It is the proxy target for the automation system:
 * server-rendered, frameset-based, table layouts, no test IDs, generic
 * class names — plus deterministic fault injection (see faults.ts).
 *
 * It exists so every scenario in /evidence/ is reproducible offline.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { consumeNativeDialog, isFaultName, resetFaults, setFault, triggerFault, faultsSnapshot } from './faults.js';
import { resetData } from './data/seed.js';
import { createSession, currentUser, destroySession, requireAuth } from './session.js';
import { membersRouter } from './routes/members.js';
import { subaccountsRouter } from './routes/subaccounts.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const CREDS = {
  user: process.env.MOCK_CU_USER ?? 'teller1',
  pass: process.env.MOCK_CU_PASS ?? 'Passw0rd!',
};

export function createApp(): express.Express {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(here, 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/static', express.static(path.join(here, 'static')));

  // ---- Test-harness endpoints (NOT part of the simulated bank app; the
  // automation policy allowlist never includes these routes). ----
  app.get('/__health', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/__faults', (_req, res) => {
    res.json(faultsSnapshot());
  });
  app.post('/__faults', (req, res) => {
    const { fault, mode, param } = req.body as { fault?: string; mode?: string; param?: number };
    if (!fault || !isFaultName(fault) || !mode || !['off', 'once', 'on'].includes(mode)) {
      res.status(400).json({ error: 'expected {fault: <name>, mode: off|once|on, param?}' });
      return;
    }
    setFault(fault, mode as 'off' | 'once' | 'on', param);
    res.json(faultsSnapshot());
  });
  app.post('/__reset', (_req, res) => {
    resetData();
    resetFaults();
    res.json({ ok: true });
  });

  // ---- Fault middleware: transient slowness and hard app errors. ----
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/static')) return next();
    const slow = triggerFault('slow_load');
    if (slow) await new Promise((r) => setTimeout(r, slow.param ?? 4000));
    const err = triggerFault('app_error');
    if (err) {
      res.status(500).render('error', {
        title: 'Application Error',
        code: 'ERR-5000',
        message: 'An unexpected application error occurred. If the problem persists, contact the help desk.',
        user: currentUser(req),
      });
      return;
    }
    next();
  });

  // ---- Auth ----
  app.get('/login', (req, res) => {
    res.render('login', {
      title: 'MockCore Teller — Sign In',
      expired: req.query.expired === '1',
      error: null,
    });
  });
  app.post('/login', (req, res) => {
    const { txtUser, txtPass } = req.body as { txtUser?: string; txtPass?: string };
    if (txtUser === CREDS.user && txtPass === CREDS.pass) {
      createSession(res, txtUser);
      res.redirect('/');
      return;
    }
    res.status(401).render('login', {
      title: 'MockCore Teller — Sign In',
      expired: false,
      error: 'Invalid operator ID or password.',
    });
  });
  app.get('/logout', (req, res) => {
    destroySession(req, res);
    res.redirect('/login');
  });

  // ---- Frameset shell ----
  app.get('/', requireAuth, (_req, res) => {
    res.render('frameset', { title: 'MockCore Teller v7.2.14' });
  });
  app.get('/banner', requireAuth, (req, res) => {
    res.render('banner', { title: 'banner', user: currentUser(req) });
  });
  app.get('/nav', requireAuth, (_req, res) => {
    res.render('nav', { title: 'menu' });
  });
  app.get('/home', requireAuth, interstitialGate, (req, res) => {
    res.render('home', { title: 'MockCore Teller — Home', user: currentUser(req), nativeDialogText: consumeNativeDialog() });
  });

  // ---- Business routes (work frame) ----
  app.use('/members', requireAuth, interstitialGate, membersRouter);
  app.use('/members', requireAuth, subaccountsRouter);

  // ---- 404 ----
  app.use((req: Request, res: Response) => {
    res.status(404).render('error', {
      title: 'Not Found',
      code: 'ERR-4040',
      message: `The requested screen (${req.path}) does not exist.`,
      user: currentUser(req),
    });
  });

  return app;
}

/**
 * Interstitial fault: a known, dismissible notice page served instead of the
 * page the operator asked for — the "recoverable condition" replay must
 * dismiss. Applies to GET page loads only; consuming the fault means the
 * Continue link's re-request goes through.
 */
function interstitialGate(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET') return next();
  const hit = triggerFault('interstitial');
  if (hit) {
    res.render('notice', {
      title: 'MockCore Teller — System Notice',
      message:
        'Nightly batch processing begins at 11:00 PM Pacific. Transactions posted after that time will appear on the next business day.',
      continueUrl: req.originalUrl,
    });
    return;
  }
  next();
}

// Start directly when run as a script (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MOCK_CU_PORT ?? 4173);
  createApp().listen(port, () => {
    console.log(`MockCore Teller running at http://localhost:${port}`);
    console.log(`Sign in with ${CREDS.user} / ${CREDS.pass}`);
  });
}
