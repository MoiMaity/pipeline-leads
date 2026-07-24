import crypto from 'node:crypto';
import { q, nowIso } from './db.js';
import { errors, parseCookies, serializeCookie, setCookie, SAFE_METHODS } from './http.js';

export const SESSION_COOKIE = 'pipeline_session';
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

/* ---------------------------------------------------------------- passwords */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- sessions */

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_TTL_SECONDS * 1000);
  q.run('INSERT INTO sessions (token, csrf, user_id, created_at, expires_at) VALUES (?,?,?,?,?)', [
    token,
    csrf,
    userId,
    created.toISOString(),
    expires.toISOString(),
  ]);
  return { token, csrf, expiresAt: expires.toISOString() };
}

export function destroySession(token) {
  if (!token) return;
  q.run('DELETE FROM sessions WHERE token = ?', [token]);
}

export function purgeExpiredSessions() {
  q.run('DELETE FROM sessions WHERE expires_at < ?', [nowIso()]);
}

function lookupSession(token) {
  if (!token) return null;
  const row = q.get(
    `SELECT s.token, s.csrf, s.expires_at,
            u.id, u.email, u.name, u.role, u.is_active
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`,
    [token],
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  if (!row.is_active) return null;
  return {
    token: row.token,
    csrf: row.csrf,
    user: { id: row.id, email: row.email, name: row.name, role: row.role },
  };
}

export function attachSessionCookie(res, session, secure) {
  setCookie(
    res,
    serializeCookie(SESSION_COOKIE, session.token, {
      maxAge: SESSION_TTL_SECONDS,
      secure,
      sameSite: 'Lax',
    }),
  );
}

export function clearSessionCookie(res, secure) {
  setCookie(res, serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure }));
}

/**
 * Resolves the caller from either a Bearer token (API clients) or the session
 * cookie (browser). Cookie-authenticated writes additionally require a CSRF token.
 */
export function resolveAuth(req) {
  const authHeader = req.headers.authorization || '';
  let via = null;
  let token = null;

  if (authHeader.toLowerCase().startsWith('bearer ')) {
    token = authHeader.slice(7).trim();
    via = 'bearer';
  } else {
    const cookies = parseCookies(req.headers.cookie || '');
    if (cookies[SESSION_COOKIE]) {
      token = cookies[SESSION_COOKIE];
      via = 'cookie';
    }
  }

  const session = lookupSession(token);
  if (!session) return { user: null, session: null, via: null };

  if (via === 'cookie' && !SAFE_METHODS.has(req.method)) {
    const supplied = req.headers['x-csrf-token'];
    if (supplied !== session.csrf) {
      throw errors.forbidden('CSRF token missing or invalid.');
    }
  }
  return { user: session.user, session, via };
}

/* ---------------------------------------------------------------- guards */

export function requireUser(ctx) {
  if (!ctx.user) throw errors.unauthorized();
  return ctx.user;
}

export function requireAdmin(ctx) {
  const user = requireUser(ctx);
  if (user.role !== 'admin') {
    throw errors.forbidden('This action is restricted to admins.');
  }
  return user;
}

export const isAdmin = (user) => Boolean(user && user.role === 'admin');
