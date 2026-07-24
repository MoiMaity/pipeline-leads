import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { boot, submitPublicLead } from './helpers.js';
import { resetRateLimits } from '../src/lib/ratelimit.js';

let app;
let admin;
let rosa;

before(async () => {
  app = await boot();
  admin = await app.signIn('admin');
  rosa = await app.signIn('rosa');

  // Seeded through the authenticated endpoint so the public rate limit stays untouched.
  for (let i = 1; i <= 25; i += 1) {
    await admin.as('/api/leads', {
      method: 'POST',
      body: {
        name: `Lead ${String(i).padStart(2, '0')}`,
        email: `lead${i}@example.com`,
        company: i % 2 === 0 ? 'Evens Ltd' : 'Odds Inc',
      },
    });
  }
  // Give Rosa three leads and move one along.
  for (const id of [1, 2, 3]) {
    await admin.as(`/api/leads/${id}/assign`, { method: 'POST', body: { assigneeId: rosa.user.id } });
  }
  await rosa.as('/api/leads/1', { method: 'PATCH', body: { status: 'contacted' } });
});

after(async () => {
  await app.close();
});

describe('pagination', () => {
  test('defaults to 20 per page with complete meta', async () => {
    const res = await admin.as('/api/leads');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 20);
    assert.deepEqual(res.body.meta, {
      page: 1,
      perPage: 20,
      total: 25,
      totalPages: 2,
      hasNext: true,
      hasPrev: false,
    });
  });

  test('walks pages without gaps or repeats', async () => {
    const first = await admin.as('/api/leads?per_page=10&page=1');
    const second = await admin.as('/api/leads?per_page=10&page=2');
    const third = await admin.as('/api/leads?per_page=10&page=3');

    assert.equal(third.body.data.length, 5);
    assert.equal(third.body.meta.hasNext, false);
    assert.equal(third.body.meta.hasPrev, true);

    const ids = [first, second, third].flatMap((r) => r.body.data.map((l) => l.id));
    assert.equal(new Set(ids).size, 25);
  });

  test('per_page is capped and a page past the end is empty, not an error', async () => {
    const capped = await admin.as('/api/leads?per_page=5000');
    assert.equal(capped.body.meta.perPage, 100);

    const past = await admin.as('/api/leads?page=99');
    assert.equal(past.status, 200);
    assert.equal(past.body.data.length, 0);
  });

  test('a non-integer page is a 400', async () => {
    const res = await admin.as('/api/leads?page=abc');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'bad_request');
  });
});

describe('filtering and sorting', () => {
  test('filters by status', async () => {
    const res = await admin.as('/api/leads?status=contacted');
    assert.equal(res.body.meta.total, 1);
    assert.equal(res.body.data[0].status, 'contacted');
  });

  test('rejects an unknown status with 400', async () => {
    const res = await admin.as('/api/leads?status=nurturing');
    assert.equal(res.status, 400);
  });

  test('filters by assignee, including me and unassigned', async () => {
    const mine = await rosa.as('/api/leads?assignee_id=me');
    assert.equal(mine.body.meta.total, 3);

    const byId = await admin.as(`/api/leads?assignee_id=${rosa.user.id}`);
    assert.equal(byId.body.meta.total, 3);

    const pool = await admin.as('/api/leads?assignee_id=unassigned');
    assert.equal(pool.body.meta.total, 22);
  });

  test('searches across name, email and company', async () => {
    const byCompany = await admin.as('/api/leads?q=Evens');
    assert.equal(byCompany.body.meta.total, 12);

    const byName = await admin.as('/api/leads?q=Lead 07');
    assert.equal(byName.body.meta.total, 1);

    const byEmail = await admin.as('/api/leads?q=lead12@');
    assert.equal(byEmail.body.meta.total, 1);
  });

  test('combines filters', async () => {
    const res = await admin.as(`/api/leads?assignee_id=${rosa.user.id}&status=new`);
    assert.equal(res.body.meta.total, 2);
  });

  test('sorts by name ascending', async () => {
    const res = await admin.as('/api/leads?sort=name&order=asc&per_page=3');
    assert.deepEqual(res.body.data.map((l) => l.name), ['Lead 01', 'Lead 02', 'Lead 03']);
  });

  test('scoping applies before pagination for members', async () => {
    const res = await rosa.as('/api/leads?per_page=100');
    assert.equal(res.body.meta.total, 25, 'members see their own plus the unclaimed pool');
    const otherOwned = res.body.data.filter((l) => l.assignee && l.assignee.id !== rosa.user.id);
    assert.equal(otherOwned.length, 0);
  });
});

describe('status codes and error shape', () => {
  test('201 with a Location header on create', async () => {
    const res = await admin.as('/api/leads', {
      method: 'POST',
      body: { name: 'Manual Entry', email: 'manual@example.com' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('location'), `/api/leads/${res.body.data.id}`);
    assert.equal(res.body.data.source, 'manual');
  });

  test('422 lists the offending fields', async () => {
    const res = await admin.as('/api/leads', { method: 'POST', body: { name: 'A', email: 'nope' } });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.ok(res.body.error.details.name);
    assert.ok(res.body.error.details.email);
  });

  test('the public form validates too', async () => {
    resetRateLimits();
    const res = await app.request('/api/public/leads', { method: 'POST', body: { name: 'X' } });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.email);
  });

  test('404 for a missing lead and for a nonsense id', async () => {
    assert.equal((await admin.as('/api/leads/999999')).status, 404);
    assert.equal((await admin.as('/api/leads/not-a-number')).status, 404);
  });

  test('404 for an unknown endpoint', async () => {
    const res = await admin.as('/api/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
  });

  test('405 with an Allow header for the wrong method', async () => {
    const res = await admin.as('/api/leads/1', { method: 'PUT', body: {} });
    assert.equal(res.status, 405);
    assert.ok(res.headers.get('allow').includes('PATCH'));
  });

  test('400 for malformed JSON', async () => {
    const res = await fetch(`${app.base}/api/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
      body: '{"name": ',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'bad_request');
  });

  test('422 when a PATCH carries nothing to change', async () => {
    const res = await admin.as('/api/leads/1', { method: 'PATCH', body: {} });
    assert.equal(res.status, 422);
  });

  test('409 when creating a duplicate account', async () => {
    const payload = { name: 'Twin', email: 'twin@test.local', password: 'Password!2026', role: 'member' };
    assert.equal((await admin.as('/api/users', { method: 'POST', body: payload })).status, 201);
    const second = await admin.as('/api/users', { method: 'POST', body: payload });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'conflict');
  });

  test('429 once the public form is hammered', async () => {
    resetRateLimits();
    let last = null;
    for (let i = 0; i < 14; i += 1) {
      last = await submitPublicLead(app, { email: `spam${i}@example.com` });
      if (last.status === 429) break;
    }
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
  });

  test('stats are scoped to the caller', async () => {
    const asAdmin = await admin.as('/api/stats');
    const asMember = await rosa.as('/api/stats');
    assert.equal(asAdmin.status, 200);
    assert.ok(asAdmin.body.data.total >= asMember.body.data.total);
    assert.ok('new' in asAdmin.body.data && 'won' in asAdmin.body.data);
  });
});
