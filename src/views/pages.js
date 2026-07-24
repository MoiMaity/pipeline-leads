import { html, raw } from './html.js';
import { shell, stageRail, statusTag, money, when, STATUS_LABEL, ALL_STATUSES } from './layout.js';
import { TRANSITIONS } from '../domain/leads.js';

/* ------------------------------------------------------------- public */

export function publicPage({ submitted = false, invalid = false } = {}) {
  const body = html`<div class="capture">
    <header class="capture__head">
      <span class="eyebrow">Pipeline · sales enquiries</span>
      <h1>Tell us what you need. A person replies within one business day.</h1>
      <p class="lede">
        Every enquiry lands in our pipeline with a named owner. No auto-responder loops, no chasing a shared inbox.
      </p>
    </header>

    <div class="capture__grid">
      <form class="card form" id="capture-form" method="post" action="/leads" novalidate>
        ${submitted
          ? html`<p class="banner banner--ok">
              Thanks — your enquiry is in. Someone will pick it up shortly.
            </p>`
          : ''}
        ${invalid
          ? html`<p class="banner banner--error">
              We need a name and a valid email address before we can route this to someone.
            </p>`
          : ''}
        <div class="field">
          <label for="name">Your name</label>
          <input id="name" name="name" required maxlength="120" autocomplete="name">
          <p class="field__error" data-error-for="name"></p>
        </div>
        <div class="field">
          <label for="email">Work email</label>
          <input id="email" name="email" type="email" required maxlength="254" autocomplete="email">
          <p class="field__error" data-error-for="email"></p>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="company">Company <span class="opt">optional</span></label>
            <input id="company" name="company" maxlength="160" autocomplete="organization">
            <p class="field__error" data-error-for="company"></p>
          </div>
          <div class="field">
            <label for="phone">Phone <span class="opt">optional</span></label>
            <input id="phone" name="phone" maxlength="40" autocomplete="tel">
            <p class="field__error" data-error-for="phone"></p>
          </div>
        </div>
        <div class="field">
          <label for="message">What are you trying to solve? <span class="opt">optional</span></label>
          <textarea id="message" name="message" rows="4" maxlength="2000"></textarea>
          <p class="field__error" data-error-for="message"></p>
        </div>
        <div class="hp" aria-hidden="true">
          <label for="website">Leave this empty</label>
          <input id="website" name="website" tabindex="-1" autocomplete="off">
        </div>
        <button class="btn btn--primary" type="submit">Send enquiry</button>
        <p class="form__foot">We use your details to reply to this enquiry. Nothing else.</p>
      </form>

      <aside class="card card--quiet">
        <h2 class="h-small">What happens after you send it</h2>
        ${stageRail('new')}
        <p class="dim small">
          Your enquiry starts at <strong>New</strong>. It only moves forward when a real person does something:
          a call, a qualification, a proposal. You can ask where it sits at any point and we can tell you exactly.
        </p>
        <p class="small"><a href="/login">Team sign in →</a></p>
      </aside>
    </div>
  </div>`;

  return shell({ title: 'New enquiry', body, wide: true });
}

/* ------------------------------------------------------------- login */

export function loginPage({ next = '/app' } = {}) {
  const body = html`<div class="auth">
    <form class="card form" id="login-form" data-next="${next}">
      <span class="eyebrow">Pipeline</span>
      <h1 class="h-small">Sign in</h1>
      <p class="banner banner--error" id="login-error" hidden></p>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="username">
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password">
      </div>
      <button class="btn btn--primary" type="submit">Sign in</button>
      <p class="small dim">Looking for the enquiry form? <a href="/">It's here</a>.</p>
    </form>
  </div>`;
  return shell({ title: 'Sign in', body });
}

/* ------------------------------------------------------------- leads list */

export function leadsPage({ user, csrf, result, counts, filters, users, activeNav }) {
  const rows = result.data.map(
    (lead) => html`<tr>
      <td class="cell-main">
        <a class="lead-link" href="/app/leads/${lead.id}">${lead.name}</a>
        <span class="cell-sub num">${lead.company || lead.email}</span>
      </td>
      <td>${statusTag(lead.status)}</td>
      <td class="cell-rail">${miniRail(lead.status)}</td>
      <td>
        ${lead.assignee
          ? html`<span class="who">${lead.assignee.name}</span>`
          : html`<span class="tag tag--open">Unclaimed</span>`}
      </td>
      <td>${money(lead.valueCents)}</td>
      <td>${when(lead.createdAt)}</td>
    </tr>`,
  );

  const body = html`<header class="page-head">
      <div>
        <span class="eyebrow">${user.role === 'admin' ? 'All leads' : 'Your leads and the unclaimed pool'}</span>
        <h1>Leads</h1>
      </div>
      <button class="btn btn--primary" id="new-lead">Add lead</button>
    </header>

    <section class="counts" aria-label="Pipeline by stage">
      ${ALL_STATUSES.map(
        (s) => html`<a class="count ${filters.status === s ? 'is-active' : ''}"
             href="?status=${s}" data-status="${s}">
          <span class="count__n num">${counts[s]}</span>
          <span class="count__l">${STATUS_LABEL[s]}</span>
        </a>`,
      )}
    </section>

    <form class="filters card" method="get" action="/app">
      <div class="field field--inline">
        <label for="q">Search</label>
        <input id="q" name="q" value="${filters.q || ''}" placeholder="Name, email or company">
      </div>
      <div class="field field--inline">
        <label for="status">Stage</label>
        <select id="status" name="status">
          <option value="">Any</option>
          ${ALL_STATUSES.map(
            (s) => html`<option value="${s}" ${filters.status === s ? raw('selected') : ''}>${STATUS_LABEL[s]}</option>`,
          )}
        </select>
      </div>
      <div class="field field--inline">
        <label for="assignee_id">Owner</label>
        <select id="assignee_id" name="assignee_id">
          <option value="">Anyone</option>
          <option value="me" ${filters.assigneeRaw === 'me' ? raw('selected') : ''}>Me</option>
          <option value="unassigned" ${filters.assigneeRaw === 'unassigned' ? raw('selected') : ''}>Unclaimed</option>
          ${users.map(
            (u) => html`<option value="${u.id}" ${String(filters.assigneeRaw) === String(u.id) ? raw('selected') : ''}>${u.name}</option>`,
          )}
        </select>
      </div>
      <div class="field field--inline">
        <label for="sort">Sort</label>
        <select id="sort" name="sort">
          <option value="created_at" ${filters.sort === 'created_at' ? raw('selected') : ''}>Newest first</option>
          <option value="updated_at" ${filters.sort === 'updated_at' ? raw('selected') : ''}>Recently touched</option>
          <option value="name" ${filters.sort === 'name' ? raw('selected') : ''}>Name</option>
        </select>
      </div>
      <button class="btn" type="submit">Apply</button>
      <a class="btn btn--ghost" href="/app">Clear</a>
    </form>

    <div class="card card--table">
      <table class="table">
        <thead>
          <tr><th>Lead</th><th>Stage</th><th class="cell-rail">Progress</th><th>Owner</th><th>Value</th><th>Received</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${result.data.length === 0
        ? html`<div class="empty">
            <p><strong>Nothing here yet.</strong></p>
            <p class="dim">Leads arrive from the public form, or add one by hand with <em>Add lead</em>.</p>
          </div>`
        : ''}
    </div>

    ${pager(result.meta, filters)}

    <dialog class="modal" id="lead-modal">
      <form class="form" id="lead-form">
        <h2 class="h-small">Add lead</h2>
        <div class="field"><label for="l-name">Name</label><input id="l-name" name="name" required></div>
        <div class="field"><label for="l-email">Email</label><input id="l-email" name="email" type="email" required></div>
        <div class="field-row">
          <div class="field"><label for="l-company">Company</label><input id="l-company" name="company"></div>
          <div class="field"><label for="l-phone">Phone</label><input id="l-phone" name="phone"></div>
        </div>
        <div class="field"><label for="l-message">Context</label><textarea id="l-message" name="message" rows="3"></textarea></div>
        <div class="modal__actions">
          <button class="btn btn--ghost" type="button" data-close>Cancel</button>
          <button class="btn btn--primary" type="submit">Add lead</button>
        </div>
      </form>
    </dialog>`;

  return shell({ title: 'Leads', user, csrf, body, active: activeNav, wide: true });
}

function miniRail(status) {
  const flow = ['new', 'contacted', 'qualified', 'proposal', 'won'];
  const idx = flow.indexOf(status);
  return html`<span class="mini" data-status="${status}" title="${STATUS_LABEL[status]}">
    ${flow.map((s, i) => html`<i class="${status === 'lost' ? 'is-lost' : i <= idx ? 'is-on' : ''}"></i>`)}
  </span>`;
}

function pager(meta, filters) {
  const qs = (page) => {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.status) params.set('status', filters.status);
    if (filters.assigneeRaw) params.set('assignee_id', filters.assigneeRaw);
    if (filters.sort) params.set('sort', filters.sort);
    params.set('page', String(page));
    return `?${params.toString()}`;
  };
  return html`<nav class="pager" aria-label="Pagination">
    <span class="num dim">
      Page ${meta.page} of ${meta.totalPages} · ${meta.total} lead${meta.total === 1 ? '' : 's'}
    </span>
    <span class="pager__btns">
      ${meta.hasPrev ? html`<a class="btn btn--sm" href="${qs(meta.page - 1)}">← Previous</a>` : ''}
      ${meta.hasNext ? html`<a class="btn btn--sm" href="${qs(meta.page + 1)}">Next →</a>` : ''}
    </span>
  </nav>`;
}

/* ------------------------------------------------------------- lead detail */

export function leadDetailPage({ user, csrf, lead, notes, activity, users, canEdit, canDelete }) {
  const allowedNext = TRANSITIONS[lead.status];
  const disabled = ALL_STATUSES.filter(
    (s) => s !== lead.status && !allowedNext.includes(s) && !(user.role === 'admin' && isReopen(lead.status, s)),
  );

  const body = html`<p class="crumb"><a href="/app">← All leads</a></p>

    <header class="page-head page-head--lead">
      <div>
        <span class="eyebrow num">Lead #${lead.id} · via ${lead.source.replace('_', ' ')}</span>
        <h1>${lead.name}</h1>
        <p class="lede">
          ${lead.company ? html`${lead.company} · ` : ''}
          <a href="mailto:${lead.email}">${lead.email}</a>
          ${lead.phone ? html` · <span class="num">${lead.phone}</span>` : ''}
        </p>
      </div>
      <div class="page-head__actions">
        ${statusTag(lead.status)}
        ${canDelete
          ? html`<button class="btn btn--danger btn--sm" id="delete-lead" data-requires-role="admin">Delete</button>`
          : ''}
      </div>
    </header>

    <section class="card" id="stage-card" data-lead="${lead.id}" data-can-edit="${canEdit ? 'yes' : 'no'}">
      <h2 class="h-small">Stage</h2>
      ${canEdit
        ? stageRail(lead.status, { interactive: true, disabledStages: disabled })
        : stageRail(lead.status)}
      ${canEdit
        ? html`<div class="stage-extra">
            ${lead.status !== 'lost' && lead.status !== 'won'
              ? html`<button class="btn btn--sm btn--ghost" data-status="lost">Mark lost</button>`
              : ''}
            ${user.role === 'admin' && (lead.status === 'lost' || lead.status === 'won')
              ? html`<button class="btn btn--sm btn--ghost" data-status="${lead.status === 'lost' ? 'contacted' : 'proposal'}" data-requires-role="admin">Reopen</button>`
              : ''}
          </div>`
        : html`<p class="dim small">Claim this lead to move it along.</p>`}
    </section>

    <div class="split">
      <section class="card">
        <h2 class="h-small">Owner</h2>
        ${lead.assignee
          ? html`<p class="who who--big">${lead.assignee.name} <span class="dim num">${lead.assignee.email}</span></p>`
          : html`<p class="dim">No one has claimed this lead.</p>`}

        ${user.role === 'admin'
          ? html`<div class="assign" data-requires-role="admin">
              <label class="small" for="assignee">Reassign to</label>
              <select id="assignee">
                <option value="">Unclaimed</option>
                ${users.map(
                  (u) => html`<option value="${u.id}" ${lead.assigneeId === u.id ? raw('selected') : ''}>${u.name} (${u.role})</option>`,
                )}
              </select>
              <button class="btn btn--sm" id="assign-btn">Save owner</button>
            </div>`
          : lead.assigneeId === null
            ? html`<button class="btn btn--sm btn--primary" id="claim-btn">Claim this lead</button>`
            : ''}

        <dl class="facts">
          <dt>Value</dt><dd>${money(lead.valueCents)}</dd>
          <dt>Received</dt><dd>${when(lead.createdAt)}</dd>
          <dt>Last touched</dt><dd>${when(lead.updatedAt)}</dd>
        </dl>
        ${lead.message ? html`<blockquote class="quote">${lead.message}</blockquote>` : ''}
      </section>

      <section class="card">
        <h2 class="h-small">Notes</h2>
        ${canEdit
          ? html`<form class="form form--tight" id="note-form">
              <div class="field">
                <label class="sr-only" for="note-body">Add a note</label>
                <textarea id="note-body" name="body" rows="3" placeholder="What happened on the call?" required></textarea>
              </div>
              <button class="btn btn--sm btn--primary" type="submit">Add note</button>
            </form>`
          : ''}
        <ul class="stream" id="notes">
          ${notes.length === 0 ? html`<li class="dim small">No notes yet.</li>` : ''}
          ${notes.map(
            (n) => html`<li class="stream__item">
              <p class="stream__meta"><strong>${n.authorName || 'Removed user'}</strong> · ${when(n.createdAt)}</p>
              <p class="stream__body">${n.body}</p>
            </li>`,
          )}
        </ul>
      </section>
    </div>

    <section class="card">
      <h2 class="h-small">Activity trail</h2>
      <ul class="trail">
        ${activity.map(
          (a) => html`<li class="trail__item" data-type="${a.type}">
            <span class="trail__dot" aria-hidden="true"></span>
            <span class="trail__text">${describe(a)}</span>
            <span class="trail__time">${when(a.createdAt)}</span>
          </li>`,
        )}
      </ul>
    </section>`;

  return shell({ title: lead.name, user, csrf, body, active: 'leads', wide: true });
}

function isReopen(from, to) {
  return (from === 'lost' && to === 'contacted') || (from === 'won' && to === 'proposal');
}

function describe(a) {
  const who = a.actorName;
  switch (a.type) {
    case 'lead.created':
      return html`<strong>${who}</strong> created this lead (${a.data.source?.replace('_', ' ') || 'manual'})`;
    case 'lead.status_changed':
      return html`<strong>${who}</strong> moved the stage from ${STATUS_LABEL[a.data.from]} to ${STATUS_LABEL[a.data.to]}`;
    case 'lead.assigned':
      return html`<strong>${who}</strong> assigned it to ${a.data.assigneeName || 'someone'}`;
    case 'lead.unassigned':
      return html`<strong>${who}</strong> returned it to the unclaimed pool`;
    case 'note.added':
      return html`<strong>${who}</strong> added a note`;
    case 'lead.updated':
      return html`<strong>${who}</strong> edited ${a.data.fields?.join(', ') || 'details'}`;
    default:
      return html`<strong>${who}</strong> ${a.type}`;
  }
}

/* ------------------------------------------------------------- team */

export function usersPage({ user, csrf, users }) {
  const body = html`<header class="page-head">
      <div><span class="eyebrow">Admin only</span><h1>Team</h1></div>
    </header>

    <div class="split">
      <section class="card card--table">
        <table class="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${users.map(
              (u) => html`<tr>
                <td class="cell-main">${u.name}</td>
                <td class="num">${u.email}</td>
                <td><span class="tag tag--role">${u.role}</span></td>
                <td>${u.isActive ? html`<span class="tag tag--ok">Active</span>` : html`<span class="tag">Off</span>`}</td>
                <td class="right">
                  ${u.id === user.id
                    ? html`<span class="dim small">You</span>`
                    : html`<button class="btn btn--sm btn--ghost toggle-user" data-id="${u.id}" data-active="${u.isActive ? '1' : '0'}">
                        ${u.isActive ? 'Deactivate' : 'Reactivate'}
                      </button>`}
                </td>
              </tr>`,
            )}
          </tbody>
        </table>
      </section>

      <section class="card">
        <h2 class="h-small">Add a teammate</h2>
        <form class="form form--tight" id="user-form">
          <div class="field"><label for="u-name">Name</label><input id="u-name" name="name" required></div>
          <div class="field"><label for="u-email">Email</label><input id="u-email" name="email" type="email" required></div>
          <div class="field">
            <label for="u-password">Temporary password</label>
            <input id="u-password" name="password" type="text" minlength="10" required>
            <p class="small dim">At least 10 characters. They can be told to change it later.</p>
          </div>
          <div class="field">
            <label for="u-role">Role</label>
            <select id="u-role" name="role">
              <option value="member">Member — own leads and the unclaimed pool</option>
              <option value="admin">Admin — everything, including the team</option>
            </select>
          </div>
          <button class="btn btn--primary" type="submit">Create account</button>
        </form>
      </section>
    </div>`;

  return shell({ title: 'Team', user, csrf, body, active: 'users', wide: true });
}

/* ------------------------------------------------------------- errors */

export function errorPage({ status, title, message, user = null }) {
  const body = html`<div class="auth">
    <div class="card">
      <span class="eyebrow num">${status}</span>
      <h1 class="h-small">${title}</h1>
      <p class="dim">${message}</p>
      <p><a class="btn btn--sm" href="${user ? '/app' : '/'}">${user ? 'Back to leads' : 'Back to the form'}</a></p>
    </div>
  </div>`;
  return shell({ title, body, user });
}
