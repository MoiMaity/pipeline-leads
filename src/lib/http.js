/**
 * Tiny HTTP layer built on node:http.
 * Gives us routing, body parsing, cookies and response helpers with no dependencies.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const errors = {
  badRequest: (msg = 'Malformed request.', details) => new HttpError(400, 'bad_request', msg, details),
  unauthorized: (msg = 'Sign in to continue.') => new HttpError(401, 'unauthorized', msg),
  forbidden: (msg = 'You do not have access to this action.') => new HttpError(403, 'forbidden', msg),
  notFound: (msg = 'Not found.') => new HttpError(404, 'not_found', msg),
  methodNotAllowed: (allow) => Object.assign(new HttpError(405, 'method_not_allowed', 'Method not allowed.'), { allow }),
  conflict: (msg, details) => new HttpError(409, 'conflict', msg, details),
  unprocessable: (details, msg = 'Some fields need attention.') =>
    new HttpError(422, 'validation_failed', msg, details),
  tooMany: (retryAfter) => Object.assign(new HttpError(429, 'rate_limited', 'Too many requests. Try again shortly.'), { retryAfter }),
};

export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const keys = [];
    const source = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        if (seg === '*') {
          keys.push('wildcard');
          return '(.*)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    routes.push({ method, regex: new RegExp(`^${source}/?$`), keys, handler });
  }

  const router = {
    routes,
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    patch: (p, h) => add('PATCH', p, h),
    put: (p, h) => add('PUT', p, h),
    delete: (p, h) => add('DELETE', p, h),
    match(method, pathname) {
      const pathMatches = [];
      for (const route of routes) {
        const m = route.regex.exec(pathname);
        if (!m) continue;
        pathMatches.push(route);
        if (route.method === method || (method === 'HEAD' && route.method === 'GET')) {
          const params = {};
          route.keys.forEach((k, i) => {
            params[k] = decodeURIComponent(m[i + 1]);
          });
          return { route, params };
        }
      }
      if (pathMatches.length > 0) {
        throw errors.methodNotAllowed([...new Set(pathMatches.map((r) => r.method))].join(', '));
      }
      return null;
    },
  };
  return router;
}

const MAX_BODY = 128 * 1024;

export async function readBody(req) {
  if (SAFE_METHODS.has(req.method)) return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw errors.badRequest('Request body is too large.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = (req.headers['content-type'] || '').split(';')[0].trim();

  if (type === 'application/json') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw errors.badRequest('Request body must be a JSON object.');
      }
      return parsed;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw errors.badRequest('Request body is not valid JSON.');
    }
  }
  if (type === 'application/x-www-form-urlencoded') {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  throw errors.badRequest(`Unsupported content type: ${type || 'none'}.`);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function setCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  list.push(cookie);
  res.setHeader('Set-Cookie', list);
}

export function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

export function noContent(res) {
  res.writeHead(204);
  res.end();
}

export function html(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...headers,
  });
  res.end(body);
}

export function redirect(res, location, status = 303) {
  res.writeHead(status, { Location: location });
  res.end();
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

export { SAFE_METHODS };
