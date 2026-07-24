import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { html as sendHtml, redirect, errors, clientIp, HttpError } from '../lib/http.js';
import { check } from '../lib/validate.js';
import { requireUser } from '../lib/auth.js';
import { rateLimit } from '../lib/ratelimit.js';
import { listUsers } from '../domain/users.js';
import * as Leads from '../domain/leads.js';
import { parseFilters } from './api.js';
import { publicPage, loginPage, leadsPage, leadDetailPage, usersPage, errorPage } from '../views/pages.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

export function registerUiRoutes(router) {
  /* ------------------------------------------------- static assets */

  router.get('/static/*', (ctx) => {
    const rel = ctx.params.wildcard || '';
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw errors.notFound('Asset not found.');
    }
    const body = fs.readFileSync(file);
    ctx.res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'public, max-age=300',
    });
    ctx.res.end(body);
  });

  router.get('/healthz', (ctx) => {
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain' });
    ctx.res.end('ok');
  });

  /* ------------------------------------------------- public */

  router.get('/', (ctx) =>
    sendHtml(ctx.res, 200, publicPage({
      submitted: ctx.query.get('submitted') === '1',
      invalid: ctx.query.get('invalid') === '1',
    })),
  );

  // Fallback for browsers without JavaScript: a plain form POST.
  router.post('/leads', (ctx) => {
    const limit = rateLimit(`public:${clientIp(ctx.req)}`, { max: 10, windowMs: 60_000 });
    if (!limit.allowed) throw errors.tooMany(limit.retryAfter);
    if (typeof ctx.body.website === 'string' && ctx.body.website.trim() !== '') {
      return redirect(ctx.res, '/?submitted=1');
    }
    try {
      const clean = validatePublic(ctx.body);
      Leads.createLead({ ...clean, source: 'web_form' }, null);
      return redirect(ctx.res, '/?submitted=1');
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) return redirect(ctx.res, '/?invalid=1');
      throw err;
    }
  });

  router.get('/login', (ctx) => {
    if (ctx.user) return redirect(ctx.res, '/app', 302);
    return sendHtml(ctx.res, 200, loginPage({ next: ctx.query.get('next') || '/app' }));
  });

  /* ------------------------------------------------- app (authenticated) */

  router.get('/app', (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login?next=/app', 302);
    const user = requireUser(ctx);
    const filters = parseFilters(ctx, user);
    filters.assigneeRaw = ctx.query.get('assignee_id') || '';
    const result = Leads.listLeads(user, filters);
    const counts = Leads.statusCounts(user);
    const users = user.role === 'admin' ? listUsers({ includeInactive: false }) : [];
    const activeNav =
      filters.assigneeRaw === 'me' ? 'mine' : filters.assigneeRaw === 'unassigned' ? 'unclaimed' : 'leads';

    return sendHtml(
      ctx.res,
      200,
      leadsPage({ user, csrf: ctx.session.csrf, result, counts, filters, users, activeNav }),
    );
  });

  router.get('/app/leads/:id', (ctx) => {
    if (!ctx.user) return redirect(ctx.res, `/login?next=/app/leads/${ctx.params.id}`, 302);
    const user = requireUser(ctx);
    const lead = Leads.getLead(Number(ctx.params.id));
    Leads.assertVisible(user, lead);

    return sendHtml(
      ctx.res,
      200,
      leadDetailPage({
        user,
        csrf: ctx.session.csrf,
        lead,
        notes: Leads.listNotes(lead.id),
        activity: Leads.listActivity(lead.id),
        users: user.role === 'admin' ? listUsers({ includeInactive: false }) : [],
        canEdit: Leads.canEdit(user, lead),
        canDelete: user.role === 'admin',
      }),
    );
  });

  router.get('/app/users', (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login?next=/app/users', 302);
    const user = requireUser(ctx);
    if (user.role !== 'admin') throw errors.forbidden('The team page is admin only.');
    return sendHtml(ctx.res, 200, usersPage({ user, csrf: ctx.session.csrf, users: listUsers() }));
  });
}

/** HTML error rendering for non-API routes. */
export function renderHtmlError(ctx, err) {
  const titles = {
    401: 'Sign in required',
    403: 'Not your lead',
    404: 'Nothing here',
    405: 'Wrong method',
    429: 'Slow down',
    500: 'Something broke',
  };
  const status = err.status || 500;
  return sendHtml(
    ctx.res,
    status,
    errorPage({
      status,
      title: titles[status] || 'Error',
      message: status === 500 ? 'The server hit an unexpected error. Try again.' : err.message,
      user: ctx.user,
    }),
  );
}

/* ------------------------------------------------- helpers */

function validatePublic(body) {
  return check(body)
    .string('name', { required: true, min: 2, max: 120 })
    .email('email', { required: true })
    .string('phone', { max: 40 })
    .string('company', { max: 160 })
    .string('message', { max: 2000 })
    .result();
}
