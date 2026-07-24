import { html, raw, toStr } from './html.js';
import { STATUSES } from '../domain/leads.js';

export const STATUS_LABEL = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  proposal: 'Proposal',
  won: 'Won',
  lost: 'Lost',
};

export function shell({ title, user = null, csrf = null, body, active = '', wide = false }) {
  return toStr(html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Pipeline</title>
${csrf ? raw(`<meta name="csrf-token" content="${csrf}">`) : ''}
<link rel="stylesheet" href="/static/styles.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='3' fill='%233A2E6B'/><path d='M4 5h8M4 8h5M4 11h3' stroke='white' stroke-width='1.6'/></svg>">
</head>
<body class="${user ? 'app' : 'public'}">
${user ? sidebar(user, active) : ''}
<main class="${wide ? 'main main--wide' : 'main'}">${body}</main>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
${user ? raw(`<script>window.__USER__=${JSON.stringify({ id: user.id, name: user.name, role: user.role })};</script>`) : ''}
<script src="/static/app.js" type="module"></script>
</body>
</html>`);
}

function sidebar(user, active) {
  const link = (href, label, key, adminOnly = false) =>
    html`<a class="nav__link ${active === key ? 'is-active' : ''}" href="${href}" ${adminOnly
      ? raw('data-requires-role="admin"')
      : ''}>${label}</a>`;

  return html`<aside class="nav">
    <div class="nav__brand">
      <span class="nav__mark" aria-hidden="true"></span>
      <span>Pipeline</span>
    </div>
    <nav class="nav__links">
      ${link('/app', 'Leads', 'leads')}
      ${link('/app?assignee_id=me', 'My leads', 'mine')}
      ${link('/app?assignee_id=unassigned', 'Unclaimed', 'unclaimed')}
      ${user.role === 'admin' ? link('/app/users', 'Team', 'users', true) : ''}
    </nav>
    <div class="nav__foot">
      <div class="nav__who">
        <span class="nav__name">${user.name}</span>
        <span class="tag tag--role">${user.role}</span>
      </div>
      <button class="btn btn--ghost btn--sm" id="logout">Sign out</button>
    </div>
  </aside>`;
}

/** Signature element: the stage rail. Order is real information here. */
export function stageRail(status, { interactive = false, disabledStages = [] } = {}) {
  const flow = ['new', 'contacted', 'qualified', 'proposal', 'won'];
  const index = flow.indexOf(status);
  const lost = status === 'lost';

  const segments = flow.map((stage, i) => {
    const state = lost ? 'muted' : i < index ? 'done' : i === index ? 'here' : 'ahead';
    const inner = html`<span class="rail__label">${STATUS_LABEL[stage]}</span>`;
    if (!interactive) {
      return html`<li class="rail__seg is-${state}">${inner}</li>`;
    }
    const disabled = disabledStages.includes(stage);
    return html`<li class="rail__seg is-${state}">
      <button class="rail__btn" data-status="${stage}" ${disabled ? raw('disabled') : ''}>${inner}</button>
    </li>`;
  });

  return html`<ol class="rail ${lost ? 'rail--lost' : ''}" aria-label="Pipeline stage">${segments}</ol>
    ${lost ? html`<p class="rail__note">Marked lost — the rail is frozen until an admin reopens it.</p>` : ''}`;
}

export function statusTag(status) {
  return html`<span class="tag tag--status" data-status="${status}">${STATUS_LABEL[status]}</span>`;
}

export function money(cents) {
  if (cents == null) return html`<span class="dim">—</span>`;
  return html`<span class="num">$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>`;
}

export function when(iso) {
  return html`<time class="num" datetime="${iso}" data-ts="${iso}">${iso.slice(0, 16).replace('T', ' ')}</time>`;
}

export const ALL_STATUSES = STATUSES;
