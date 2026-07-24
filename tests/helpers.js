process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

import { createApp } from '../src/app.js';
import { createUser } from '../src/domain/users.js';
import { resetRateLimits } from '../src/lib/ratelimit.js';

export const CREDENTIALS = {
  admin: { email: 'admin@test.local', name: 'Ada Admin', role: 'admin', password: 'AdminPass!2026' },
  rosa: { email: 'rosa@test.local', name: 'Rosa Member', role: 'member', password: 'MemberPass!2026' },
  kwame: { email: 'kwame@test.local', name: 'Kwame Member', role: 'member', password: 'MemberPass!2026' },
};

export async function boot() {
  resetRateLimits();
  const server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const users = {};
  for (const [key, spec] of Object.entries(CREDENTIALS)) {
    users[key] = createUser(spec);
  }

  const harness = {
    base,
    users,
    server,
    request: (path, options) => request(base, path, options),
    async signIn(key) {
      const res = await request(base, '/api/auth/login', {
        method: 'POST',
        body: { email: CREDENTIALS[key].email, password: CREDENTIALS[key].password },
      });
      if (res.status !== 200) throw new Error(`sign-in failed for ${key}: ${res.status}`);
      return {
        token: res.body.data.token,
        csrf: res.body.data.csrfToken,
        cookie: parseSetCookie(res.headers.get('set-cookie')),
        user: res.body.data.user,
        as: (path, options = {}) => request(base, path, { ...options, token: res.body.data.token }),
      };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return harness;
}

async function request(base, path, { method = 'GET', body, token, headers = {}, cookie } = {}) {
  const finalHeaders = { Accept: 'application/json', ...headers };
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  if (token) finalHeaders.Authorization = `Bearer ${token}`;
  if (cookie) finalHeaders.Cookie = cookie;

  const res = await fetch(`${base}${path}`, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });

  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

function parseSetCookie(header) {
  if (!header) return null;
  return header.split(';')[0];
}

export async function submitPublicLead(harness, overrides = {}) {
  const res = await harness.request('/api/public/leads', {
    method: 'POST',
    body: {
      name: 'Priya Raman',
      email: 'priya@northgate.io',
      company: 'Northgate Logistics',
      message: 'Forty trucks, all tracked in spreadsheets.',
      ...overrides,
    },
  });
  return res;
}
