import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { boot, CREDENTIALS, submitPublicLead } from './helpers.js';

let app;
let admin;
let rosa;
let kwame;

before(async () => {
  app = await boot();
  admin = await app.signIn('admin');
  rosa = await app.signIn('rosa');
  kwame = await app.signIn('kwame');
});

after(async () => {
  await app.close();
});

describe('sign in', () => {
  test('rejects a wrong password with 401 and no session', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      body: { email: CREDENTIALS.admin.email, password: 'not-the-password' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'unauthorized');
    assert.equal(res.headers.get('set-cookie'), null);
  });

  test('rejects an unknown email with the same 401', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      body: { email: 'nobody@test.local', password: 'AdminPass!2026' },
    });
    assert.equal(res.status, 401);
  });

  test('returns a token, a csrf token and an HttpOnly cookie on success', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      body: { email: CREDENTIALS.rosa.email, password: CREDENTIALS.rosa.password },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.token);
    assert.ok(res.body.data.csrfToken);
    assert.match(res.headers.get('set-cookie'), /pipeline_session=/);
    assert.match(res.headers.get('set-cookie'), /HttpOnly/);
    assert.match(res.headers.get('set-cookie'), /SameSite=Lax/);
  });

  test('logging out invalidates the token', async () => {
    const session = await app.signIn('kwame');
    assert.equal((await session.as('/api/auth/me')).status, 200);
    assert.equal((await session.as('/api/auth/logout', { method: 'POST' })).status, 204);
    assert.equal((await session.as('/api/auth/me')).status, 401);
  });
});

describe('unauthenticated access', () => {
  test('every private endpoint answers 401', async () => {
    const endpoints = [
      ['GET', '/api/leads'],
      ['POST', '/api/leads'],
      ['GET', '/api/leads/1'],
      ['PATCH', '/api/leads/1'],
      ['DELETE', '/api/leads/1'],
      ['GET', '/api/leads/1/notes'],
      ['POST', '/api/leads/1/notes'],
      ['GET', '/api/leads/1/activity'],
      ['GET', '/api/users'],
      ['GET', '/api/stats'],
    ];
    for (const [method, path] of endpoints) {
      const res = await app.request(path, { method, body: method === 'GET' ? undefined : {} });
      assert.equal(res.status, 401, `${method} ${path} should be 401`);
    }
  });

  test('a bogus bearer token is not accepted', async () => {
    const res = await app.request('/api/leads', { token: 'made-up-token' });
    assert.equal(res.status, 401);
  });

  test('the public capture endpoint stays open', async () => {
    const res = await submitPublicLead(app, { email: 'open@test.local' });
    assert.equal(res.status, 201);
  });

  test('the app pages redirect to sign in', async () => {
    const res = await app.request('/app');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login?next=/app');
  });
});

describe('member restrictions', () => {
  test('members cannot list the team', async () => {
    const res = await rosa.as('/api/users');
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
  });

  test('members cannot create accounts', async () => {
    const res = await rosa.as('/api/users', {
      method: 'POST',
      body: { name: 'Sneaky', email: 'sneaky@test.local', password: 'Password!2026', role: 'admin' },
    });
    assert.equal(res.status, 403);
  });

  test('members cannot open the admin team page', async () => {
    const res = await app.request('/app/users', {
      headers: { Cookie: rosa.cookie },
    });
    assert.equal(res.status, 403);
  });

  test('admins can do all of the above', async () => {
    assert.equal((await admin.as('/api/users')).status, 200);
    const res = await app.request('/app/users', { headers: { Cookie: admin.cookie } });
    assert.equal(res.status, 200);
  });

  test("a member cannot see, edit or delete another member's lead", async () => {
    const created = await submitPublicLead(app, { email: 'owned@test.local' });
    const leadId = created.body.data.id;

    await admin.as(`/api/leads/${leadId}/assign`, { method: 'POST', body: { assigneeId: rosa.user.id } });

    assert.equal((await rosa.as(`/api/leads/${leadId}`)).status, 200);

    // Invisible to the other member: 404, not 403, so existence is not leaked.
    const seen = await kwame.as(`/api/leads/${leadId}`);
    assert.equal(seen.status, 404);

    const patched = await kwame.as(`/api/leads/${leadId}`, {
      method: 'PATCH',
      body: { status: 'contacted' },
    });
    assert.equal(patched.status, 404);

    const deleted = await rosa.as(`/api/leads/${leadId}`, { method: 'DELETE' });
    assert.equal(deleted.status, 403, 'members never delete, even their own leads');

    assert.equal((await admin.as(`/api/leads/${leadId}`)).status, 200, 'admins see everything');
  });

  test('a member cannot assign a lead to somebody else', async () => {
    const created = await submitPublicLead(app, { email: 'pool@test.local' });
    const leadId = created.body.data.id;

    const stolen = await rosa.as(`/api/leads/${leadId}/assign`, {
      method: 'POST',
      body: { assigneeId: kwame.user.id },
    });
    assert.equal(stolen.status, 403);

    const claimed = await rosa.as(`/api/leads/${leadId}/assign`, {
      method: 'POST',
      body: { assigneeId: rosa.user.id },
    });
    assert.equal(claimed.status, 200);

    const takeover = await kwame.as(`/api/leads/${leadId}/assign`, {
      method: 'POST',
      body: { assigneeId: kwame.user.id },
    });
    assert.equal(takeover.status, 404, 'once claimed the lead is invisible to other members');
  });

  test('an unclaimed lead is visible to members but not editable until claimed', async () => {
    const created = await submitPublicLead(app, { email: 'unclaimed@test.local' });
    const leadId = created.body.data.id;

    assert.equal((await kwame.as(`/api/leads/${leadId}`)).status, 200);

    const patched = await kwame.as(`/api/leads/${leadId}`, {
      method: 'PATCH',
      body: { status: 'contacted' },
    });
    assert.equal(patched.status, 403);
    assert.match(patched.body.error.message, /Claim this lead/);
  });

  test('a deactivated member loses access immediately', async () => {
    const session = await app.signIn('kwame');
    assert.equal((await session.as('/api/leads')).status, 200);

    await admin.as(`/api/users/${session.user.id}`, { method: 'PATCH', body: { isActive: false } });
    assert.equal((await session.as('/api/leads')).status, 401);

    await admin.as(`/api/users/${session.user.id}`, { method: 'PATCH', body: { isActive: true } });
  });
});

describe('csrf protection for cookie sessions', () => {
  test('a cookie-only write is rejected without the csrf header', async () => {
    const res = await app.request('/api/leads', {
      method: 'POST',
      headers: { Cookie: admin.cookie },
      body: { name: 'CSRF Victim', email: 'csrf@test.local' },
    });
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /CSRF/);
  });

  test('the same write succeeds with the csrf header', async () => {
    const res = await app.request('/api/leads', {
      method: 'POST',
      headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
      body: { name: 'CSRF Ok', email: 'csrf-ok@test.local' },
    });
    assert.equal(res.status, 201);
  });

  test('reads are unaffected', async () => {
    const res = await app.request('/api/leads', { headers: { Cookie: admin.cookie } });
    assert.equal(res.status, 200);
  });
});
