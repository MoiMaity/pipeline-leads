import { json, noContent, errors, clientIp } from '../lib/http.js';
import { check, intParam, enumParam } from '../lib/validate.js';
import { rateLimit } from '../lib/ratelimit.js';
import {
  createSession,
  destroySession,
  attachSessionCookie,
  clearSessionCookie,
  requireUser,
  requireAdmin,
  isAdmin,
} from '../lib/auth.js';
import { authenticate, createUser, listUsers, findUserById, setUserActive, ROLES } from '../domain/users.js';
import * as Leads from '../domain/leads.js';

const MAX_PER_PAGE = 100;

export function registerApiRoutes(router) {
  /* ------------------------------------------------- public capture */

  router.post('/api/public/leads', (ctx) => {
    const limit = rateLimit(`public:${clientIp(ctx.req)}`, { max: 10, windowMs: 60_000 });
    if (!limit.allowed) throw errors.tooMany(limit.retryAfter);

    // Honeypot: real people never fill this in.
    if (typeof ctx.body.website === 'string' && ctx.body.website.trim() !== '') {
      return json(ctx.res, 201, { data: { received: true } });
    }

    const payload = check(ctx.body)
      .string('name', { required: true, min: 2, max: 120 })
      .email('email', { required: true })
      .string('phone', { max: 40 })
      .string('company', { max: 160 })
      .string('message', { max: 2000 })
      .result();

    const lead = Leads.createLead({ ...payload, source: 'web_form' }, null);
    return json(ctx.res, 201, {
      data: { id: lead.id, status: lead.status, createdAt: lead.createdAt },
    });
  });

  /* ------------------------------------------------- auth */

  router.post('/api/auth/login', (ctx) => {
    const ip = clientIp(ctx.req);
    const limit = rateLimit(`login:${ip}`, { max: 10, windowMs: 15 * 60_000 });
    if (!limit.allowed) throw errors.tooMany(limit.retryAfter);

    const { email, password } = ctx.body;
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw errors.unprocessable({
        email: typeof email === 'string' ? undefined : 'This field is required.',
        password: typeof password === 'string' ? undefined : 'This field is required.',
      });
    }
    const user = authenticate(email, password);
    if (!user) throw errors.unauthorized('Email or password is incorrect.');

    const session = createSession(user.id);
    attachSessionCookie(ctx.res, session, ctx.secure);
    return json(ctx.res, 200, {
      data: { user, token: session.token, csrfToken: session.csrf, expiresAt: session.expiresAt },
    });
  });

  router.post('/api/auth/logout', (ctx) => {
    if (ctx.session) destroySession(ctx.session.token);
    clearSessionCookie(ctx.res, ctx.secure);
    return noContent(ctx.res);
  });

  router.get('/api/auth/me', (ctx) => {
    const user = requireUser(ctx);
    return json(ctx.res, 200, { data: { user, csrfToken: ctx.session.csrf } });
  });

  /* ------------------------------------------------- leads */

  router.get('/api/leads', (ctx) => {
    const user = requireUser(ctx);
    return json(ctx.res, 200, Leads.listLeads(user, parseFilters(ctx, user)));
  });

  router.post('/api/leads', (ctx) => {
    const user = requireUser(ctx);
    const payload = check(ctx.body)
      .string('name', { required: true, min: 2, max: 120 })
      .email('email', { required: true })
      .string('phone', { max: 40 })
      .string('company', { max: 160 })
      .string('message', { max: 2000 })
      .string('source', { max: 40 })
      .integer('valueCents', { min: 0, nullable: true })
      .integer('assigneeId', { min: 1, nullable: true })
      .result();

    if (payload.assigneeId != null && !isAdmin(user) && payload.assigneeId !== user.id) {
      throw errors.forbidden('Members can only assign leads to themselves.');
    }
    if (payload.assigneeId != null && !findUserById(payload.assigneeId)) {
      throw errors.unprocessable({ assigneeId: 'That user does not exist.' });
    }

    const lead = Leads.createLead({ source: 'manual', ...payload }, user);
    return json(ctx.res, 201, { data: lead }, { Location: `/api/leads/${lead.id}` });
  });

  router.get('/api/leads/:id', (ctx) => {
    const user = requireUser(ctx);
    const lead = Leads.assertVisible(user, Leads.getLead(idParam(ctx)));
    return json(ctx.res, 200, {
      data: { ...lead, permissions: { canEdit: Leads.canEdit(user, lead), canDelete: isAdmin(user) } },
    });
  });

  router.patch('/api/leads/:id', (ctx) => {
    const user = requireUser(ctx);
    const lead = Leads.assertEditable(user, Leads.getLead(idParam(ctx)));
    const changes = check(ctx.body)
      .string('name', { min: 2, max: 120 })
      .email('email')
      .string('phone', { max: 40 })
      .string('company', { max: 160 })
      .string('message', { max: 2000 })
      .integer('valueCents', { min: 0, nullable: true })
      .enum('status', Leads.STATUSES)
      .result();

    if (Object.keys(changes).length === 0) {
      throw errors.unprocessable({ body: 'Provide at least one field to update.' });
    }
    return json(ctx.res, 200, { data: Leads.updateLead(lead, changes, user) });
  });

  router.delete('/api/leads/:id', (ctx) => {
    const user = requireAdmin(ctx);
    const lead = Leads.getLead(idParam(ctx));
    if (!lead) throw errors.notFound('Lead not found.');
    Leads.deleteLead(lead, user);
    return noContent(ctx.res);
  });

  router.post('/api/leads/:id/assign', (ctx) => {
    const user = requireUser(ctx);
    const lead = Leads.assertVisible(user, Leads.getLead(idParam(ctx)));
    if (!('assigneeId' in ctx.body)) {
      throw errors.unprocessable({ assigneeId: 'This field is required (use null to unassign).' });
    }
    const assigneeId = ctx.body.assigneeId === null ? null : Number(ctx.body.assigneeId);
    if (assigneeId !== null && !Number.isInteger(assigneeId)) {
      throw errors.unprocessable({ assigneeId: 'Must be a user id or null.' });
    }
    return json(ctx.res, 200, { data: Leads.assignLead(lead, assigneeId, user) });
  });

  /* ------------------------------------------------- notes + activity */

  router.get('/api/leads/:id/notes', (ctx) => {
    const user = requireUser(ctx);
    const lead = Leads.assertVisible(user, Leads.getLead(idParam(ctx)));
    return json(ctx.res, 200, { data: Leads.listNotes(lead.id) });
  });

  router.post('/api/leads/:id/notes', (ctx) => {
    const user = requireUser(ctx);
    const lead = Leads.assertEditable(user, Leads.getLead(idParam(ctx)));
    const { body } = check(ctx.body).string('body', { required: true, min: 1, max: 4000 }).result();
    const note = Leads.addNote(lead.id, body, user);
    return json(ctx.res, 201, { data: note });
  });

  router.get('/api/leads/:id/activity', (ctx) => {
    const user = requireUser(ctx);
    const lead = Leads.assertVisible(user, Leads.getLead(idParam(ctx)));
    return json(ctx.res, 200, { data: Leads.listActivity(lead.id) });
  });

  /* ------------------------------------------------- users + stats */

  router.get('/api/users', (ctx) => {
    requireAdmin(ctx);
    return json(ctx.res, 200, { data: listUsers() });
  });

  router.post('/api/users', (ctx) => {
    requireAdmin(ctx);
    const payload = check(ctx.body)
      .string('name', { required: true, min: 2, max: 120 })
      .email('email', { required: true })
      .string('password', { required: true, min: 10, max: 200, trim: false })
      .enum('role', ROLES, { required: true })
      .result();
    const user = createUser(payload);
    return json(ctx.res, 201, { data: user }, { Location: `/api/users/${user.id}` });
  });

  router.patch('/api/users/:id', (ctx) => {
    const admin = requireAdmin(ctx);
    const id = idParam(ctx);
    if (!findUserById(id)) throw errors.notFound('User not found.');
    if (id === admin.id && ctx.body.isActive === false) {
      throw errors.conflict('You cannot deactivate your own account.');
    }
    if (typeof ctx.body.isActive !== 'boolean') {
      throw errors.unprocessable({ isActive: 'Must be true or false.' });
    }
    return json(ctx.res, 200, { data: setUserActive(id, ctx.body.isActive) });
  });

  router.get('/api/stats', (ctx) => {
    const user = requireUser(ctx);
    return json(ctx.res, 200, { data: Leads.statusCounts(user) });
  });
}

/* ------------------------------------------------- helpers */

function idParam(ctx) {
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id < 1) throw errors.notFound('Lead not found.');
  return id;
}

export function parseFilters(ctx, user) {
  const qs = ctx.query;
  const rawAssignee = qs.get('assignee_id');
  let assignee;
  if (rawAssignee === 'me') assignee = user.id;
  else if (rawAssignee === 'unassigned') assignee = 'unassigned';
  else if (rawAssignee) {
    const n = Number(rawAssignee);
    if (!Number.isInteger(n)) {
      throw errors.badRequest('Query parameter "assignee_id" must be an integer, "me" or "unassigned".');
    }
    assignee = n;
  }

  return {
    page: intParam(qs.get('page'), 1, { min: 1, name: 'page' }),
    perPage: intParam(qs.get('per_page'), 20, { min: 1, max: MAX_PER_PAGE, name: 'per_page' }),
    status: enumParam(qs.get('status'), Leads.STATUSES, 'status'),
    assignee,
    q: (qs.get('q') || '').trim() || null,
    createdAfter: qs.get('created_after') || null,
    createdBefore: qs.get('created_before') || null,
    sort: enumParam(qs.get('sort'), ['created_at', 'updated_at', 'name', 'status'], 'sort') || 'created_at',
    order: enumParam(qs.get('order'), ['asc', 'desc'], 'order') || 'desc',
  };
}
