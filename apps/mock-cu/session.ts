/**
 * Minimal cookie-session for the mock app, no deps. Matches how legacy
 * server-rendered apps behave: an opaque session cookie, server-side state,
 * and hard redirects to the login screen on expiry.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { triggerFault } from './faults.js';

const COOKIE = 'mcsid';

interface SessionData {
  user: string;
  createdAt: number;
}

const sessions = new Map<string, SessionData>();

export function createSession(res: Response, user: string): void {
  const sid = randomUUID();
  sessions.set(sid, { user, createdAt: Date.now() });
  res.setHeader('Set-Cookie', `${COOKIE}=${sid}; HttpOnly; Path=/; SameSite=Lax`);
}

export function destroySession(req: Request, res: Response): void {
  const sid = readSid(req);
  if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie', `${COOKIE}=deleted; HttpOnly; Path=/; Max-Age=0`);
}

export function currentUser(req: Request): string | undefined {
  const sid = readSid(req);
  return sid ? sessions.get(sid)?.user : undefined;
}

function readSid(req: Request): string | undefined {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === COOKIE && v) return v;
  }
  return undefined;
}

/**
 * Auth guard for operator pages. Also the injection point for the
 * session_timeout fault: when armed, the operator's session is destroyed
 * mid-flow and the app redirects to the sign-in screen with an "expired"
 * banner — exactly what replay's SESSION_TIMEOUT recovery must handle.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!currentUser(req)) {
    res.redirect('/login');
    return;
  }
  if (triggerFault('session_timeout')) {
    destroySession(req, res);
    res.redirect('/login?expired=1');
    return;
  }
  next();
}
