/* Client behaviour. The server is the authority on permissions; this file keeps the
   interface honest so people are never shown a control they cannot use. */

const user = window.__USER__ || null;
const csrf = document.querySelector('meta[name="csrf-token"]')?.content || null;

/* ---------------------------------------------------- client-side role gating */

for (const el of document.querySelectorAll('[data-requires-role]')) {
  const needed = el.dataset.requiresRole;
  if (!user || user.role !== needed) el.remove();
}

/* ---------------------------------------------------- helpers */

const toastEl = document.getElementById('toast');
let toastTimer;

function toast(message, isError = false) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.toggle('is-error', isError);
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 3200);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf) headers['X-CSRF-Token'] = csrf;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return null;
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload?.error?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = payload?.error?.code;
    err.details = payload?.error?.details;
    throw err;
  }
  return payload;
}

function showFieldErrors(form, details = {}) {
  for (const node of form.querySelectorAll('.field__error')) node.textContent = '';
  for (const [field, message] of Object.entries(details)) {
    const node = form.querySelector(`[data-error-for="${field}"]`);
    if (node) node.textContent = message;
  }
}

function localizeTimes() {
  for (const el of document.querySelectorAll('time[data-ts]')) {
    const d = new Date(el.dataset.ts);
    if (!Number.isNaN(d.getTime())) {
      el.textContent = d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
  }
}
localizeTimes();

const formData = (form) => Object.fromEntries(new FormData(form).entries());

/* ---------------------------------------------------- public capture form */

const capture = document.getElementById('capture-form');
if (capture) {
  capture.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = capture.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api('/api/public/leads', { method: 'POST', body: formData(capture) });
      capture.reset();
      showFieldErrors(capture, {});
      capture.insertAdjacentHTML(
        'afterbegin',
        '<p class="banner banner--ok">Thanks — your enquiry is in. Someone will pick it up shortly.</p>',
      );
    } catch (err) {
      if (err.details) showFieldErrors(capture, err.details);
      toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

/* ---------------------------------------------------- login */

const login = document.getElementById('login-form');
if (login) {
  const errorBanner = document.getElementById('login-error');
  login.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBanner.hidden = true;
    try {
      await api('/api/auth/login', { method: 'POST', body: formData(login) });
      window.location.assign(login.dataset.next || '/app');
    } catch (err) {
      errorBanner.textContent = err.message;
      errorBanner.hidden = false;
    }
  });
}

document.getElementById('logout')?.addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.assign('/login');
});

/* ---------------------------------------------------- lead list */

const modal = document.getElementById('lead-modal');
document.getElementById('new-lead')?.addEventListener('click', () => modal?.showModal());
modal?.querySelector('[data-close]')?.addEventListener('click', () => modal.close());

document.getElementById('lead-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const { data } = await api('/api/leads', { method: 'POST', body: formData(form) });
    window.location.assign(`/app/leads/${data.id}`);
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------------------------------------------- lead detail */

const stageCard = document.getElementById('stage-card');
if (stageCard) {
  const leadId = stageCard.dataset.lead;

  stageCard.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-status]');
    if (!button || button.disabled) return;
    button.disabled = true;
    try {
      await api(`/api/leads/${leadId}`, { method: 'PATCH', body: { status: button.dataset.status } });
      window.location.reload();
    } catch (err) {
      toast(err.message, true);
      button.disabled = false;
    }
  });

  document.getElementById('claim-btn')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await api(`/api/leads/${leadId}/assign`, { method: 'POST', body: { assigneeId: user.id } });
      window.location.reload();
    } catch (err) {
      toast(err.message, true);
      event.currentTarget.disabled = false;
    }
  });

  document.getElementById('assign-btn')?.addEventListener('click', async () => {
    const select = document.getElementById('assignee');
    const value = select.value === '' ? null : Number(select.value);
    try {
      await api(`/api/leads/${leadId}/assign`, { method: 'POST', body: { assigneeId: value } });
      window.location.reload();
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById('note-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api(`/api/leads/${leadId}/notes`, { method: 'POST', body: formData(form) });
      window.location.reload();
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById('delete-lead')?.addEventListener('click', async () => {
    if (!window.confirm('Delete this lead and its notes? This cannot be undone.')) return;
    try {
      await api(`/api/leads/${leadId}`, { method: 'DELETE' });
      window.location.assign('/app');
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ---------------------------------------------------- team */

document.getElementById('user-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api('/api/users', { method: 'POST', body: formData(form) });
    window.location.reload();
  } catch (err) {
    toast(err.message, true);
  }
});

for (const button of document.querySelectorAll('.toggle-user')) {
  button.addEventListener('click', async () => {
    try {
      await api(`/api/users/${button.dataset.id}`, {
        method: 'PATCH',
        body: { isActive: button.dataset.active !== '1' },
      });
      window.location.reload();
    } catch (err) {
      toast(err.message, true);
    }
  });
}
