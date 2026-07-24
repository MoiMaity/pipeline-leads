import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { boot, submitPublicLead } from './helpers.js';

let app;
let admin;
let rosa;

before(async () => {
  app = await boot();
  admin = await app.signIn('admin');
  rosa = await app.signIn('rosa');
});

after(async () => {
  await app.close();
});

/**
 * Core flow 1: an enquiry arrives from the public form, an admin routes it,
 * the owner works it through the pipeline, and every step lands in the trail.
 */
describe('flow: capture → assign → work → won', () => {
  test('runs end to end and records an accurate activity trail', async () => {
    const created = await submitPublicLead(app, { email: 'flow@northgate.io' });
    assert.equal(created.status, 201);
    const leadId = created.body.data.id;
    assert.equal(created.body.data.status, 'new');

    // The public form must not expose internals.
    assert.deepEqual(Object.keys(created.body.data).sort(), ['createdAt', 'id', 'status']);

    // Admin assigns it.
    const assigned = await admin.as(`/api/leads/${leadId}/assign`, {
      method: 'POST',
      body: { assigneeId: rosa.user.id },
    });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.data.assignee.id, rosa.user.id);
    assert.equal(assigned.body.data.assignee.name, 'Rosa Member');

    // Owner walks it up the pipeline.
    for (const status of ['contacted', 'qualified', 'proposal', 'won']) {
      const res = await rosa.as(`/api/leads/${leadId}`, { method: 'PATCH', body: { status } });
      assert.equal(res.status, 200, `moving to ${status}`);
      assert.equal(res.body.data.status, status);
    }

    // Notes are timestamped and attributed.
    const note = await rosa.as(`/api/leads/${leadId}/notes`, {
      method: 'POST',
      body: { body: 'Signed on the second call. Kickoff booked for Monday.' },
    });
    assert.equal(note.status, 201);
    assert.equal(note.body.data.authorName, 'Rosa Member');
    assert.ok(!Number.isNaN(Date.parse(note.body.data.createdAt)));

    const notes = await rosa.as(`/api/leads/${leadId}/notes`);
    assert.equal(notes.body.data.length, 1);

    // The trail holds every event, newest first.
    const trail = await admin.as(`/api/leads/${leadId}/activity`);
    assert.equal(trail.status, 200);
    const types = trail.body.data.map((a) => a.type);
    assert.deepEqual(types, [
      'note.added',
      'lead.status_changed',
      'lead.status_changed',
      'lead.status_changed',
      'lead.status_changed',
      'lead.assigned',
      'lead.created',
    ]);

    const firstMove = trail.body.data.find(
      (a) => a.type === 'lead.status_changed' && a.data.from === 'new',
    );
    assert.deepEqual(firstMove.data, { from: 'new', to: 'contacted' });
    assert.equal(firstMove.actorName, 'Rosa Member');

    const creation = trail.body.data.at(-1);
    assert.equal(creation.actorName, 'Public form');
    assert.equal(creation.actorId, null);

    // updatedAt moved with the work.
    const final = await rosa.as(`/api/leads/${leadId}`);
    assert.ok(new Date(final.body.data.updatedAt) >= new Date(final.body.data.createdAt));
    assert.deepEqual(final.body.data.permissions, { canEdit: true, canDelete: false });
  });
});

/**
 * Core flow 2: the pipeline refuses illegal moves, lets anyone drop a lead,
 * and only lets an admin reopen it.
 */
describe('flow: pipeline rules and reopening', () => {
  let leadId;

  before(async () => {
    const created = await submitPublicLead(app, { email: 'rules@harborworks.com' });
    leadId = created.body.data.id;
    await admin.as(`/api/leads/${leadId}/assign`, { method: 'POST', body: { assigneeId: rosa.user.id } });
  });

  test('skipping a stage is a 409 with the allowed moves attached', async () => {
    const res = await rosa.as(`/api/leads/${leadId}`, { method: 'PATCH', body: { status: 'won' } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'conflict');
    assert.deepEqual(res.body.error.details, { from: 'new', to: 'won', allowed: ['contacted', 'lost'] });
  });

  test('an unknown status is a 422, not a 409', async () => {
    const res = await rosa.as(`/api/leads/${leadId}`, { method: 'PATCH', body: { status: 'nurturing' } });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.status);
  });

  test('a lead can be dropped to lost from any open stage', async () => {
    await rosa.as(`/api/leads/${leadId}`, { method: 'PATCH', body: { status: 'contacted' } });
    const res = await rosa.as(`/api/leads/${leadId}`, { method: 'PATCH', body: { status: 'lost' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'lost');
  });

  test('a member cannot reopen a lost lead', async () => {
    const res = await rosa.as(`/api/leads/${leadId}`, { method: 'PATCH', body: { status: 'contacted' } });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body.error.details.allowed, []);
  });

  test('an admin can reopen it, and the trail shows who did it', async () => {
    const res = await admin.as(`/api/leads/${leadId}`, { method: 'PATCH', body: { status: 'contacted' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'contacted');

    const trail = await admin.as(`/api/leads/${leadId}/activity`);
    const reopen = trail.body.data.find((a) => a.data.from === 'lost' && a.data.to === 'contacted');
    assert.equal(reopen.actorName, 'Ada Admin');
  });

  test('unassigning returns the lead to the unclaimed pool', async () => {
    const res = await admin.as(`/api/leads/${leadId}/assign`, {
      method: 'POST',
      body: { assigneeId: null },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.assignee, null);

    const trail = await admin.as(`/api/leads/${leadId}/activity`);
    assert.equal(trail.body.data[0].type, 'lead.unassigned');
  });

  test('deleting a lead removes it and its notes', async () => {
    const created = await submitPublicLead(app, { email: 'doomed@test.local' });
    const doomedId = created.body.data.id;
    await admin.as(`/api/leads/${doomedId}/assign`, { method: 'POST', body: { assigneeId: admin.user.id } });
    await admin.as(`/api/leads/${doomedId}/notes`, { method: 'POST', body: { body: 'Duplicate of #1.' } });

    const deleted = await admin.as(`/api/leads/${doomedId}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);

    assert.equal((await admin.as(`/api/leads/${doomedId}`)).status, 404);
    assert.equal((await admin.as(`/api/leads/${doomedId}/notes`)).status, 404);
  });
});
