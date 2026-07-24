import { q, nowIso } from '../lib/db.js';
import { errors } from '../lib/http.js';
import { isAdmin } from '../lib/auth.js';
import { findUserById } from './users.js';

export const STATUSES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];
export const OPEN_STATUSES = ['new', 'contacted', 'qualified', 'proposal'];
export const TERMINAL_STATUSES = ['won', 'lost'];

/** Allowed forward moves. Anyone can drop a lead to `lost`; only admins reopen. */
export const TRANSITIONS = {
  new: ['contacted', 'lost'],
  contacted: ['qualified', 'lost'],
  qualified: ['proposal', 'lost'],
  proposal: ['won', 'lost'],
  won: [],
  lost: [],
};

const ADMIN_ONLY_TRANSITIONS = {
  won: ['proposal'],
  lost: ['contacted'],
};

const SORTABLE = { created_at: 'l.created_at', updated_at: 'l.updated_at', name: 'l.name', status: 'l.status' };

const SELECT = `
  SELECT l.id, l.name, l.email, l.phone, l.company, l.source, l.message,
         l.value_cents AS valueCents, l.status, l.assignee_id AS assigneeId,
         l.created_at AS createdAt, l.updated_at AS updatedAt,
         u.name AS assigneeName, u.email AS assigneeEmail
    FROM leads l
    LEFT JOIN users u ON u.id = l.assignee_id`;

function shape(row) {
  if (!row) return null;
  const { assigneeName, assigneeEmail, ...rest } = row;
  return {
    ...rest,
    assignee: rest.assigneeId ? { id: rest.assigneeId, name: assigneeName, email: assigneeEmail } : null,
  };
}

/* ------------------------------------------------------------ permissions */

/**
 * Members see leads assigned to them plus the unclaimed pool.
 * Leads owned by another member are invisible (404, so we do not leak existence).
 */
export function canView(user, lead) {
  if (isAdmin(user)) return true;
  return lead.assigneeId === null || lead.assigneeId === user.id;
}

/** Editing requires ownership; an unclaimed lead must be claimed first. */
export function canEdit(user, lead) {
  if (isAdmin(user)) return true;
  return lead.assigneeId === user.id;
}

export function assertVisible(user, lead) {
  if (!lead) throw errors.notFound('Lead not found.');
  if (!canView(user, lead)) throw errors.notFound('Lead not found.');
  return lead;
}

export function assertEditable(user, lead) {
  assertVisible(user, lead);
  if (!canEdit(user, lead)) {
    throw errors.forbidden('Claim this lead before making changes to it.');
  }
  return lead;
}

/* ------------------------------------------------------------ activity */

export function recordActivity(leadId, actor, type, data = {}) {
  q.run(
    'INSERT INTO activities (lead_id, actor_id, actor_name, type, data, created_at) VALUES (?,?,?,?,?,?)',
    [leadId, actor?.id ?? null, actor?.name ?? 'Public form', type, JSON.stringify(data), nowIso()],
  );
}

export function listActivity(leadId) {
  return q
    .all(
      `SELECT id, lead_id AS leadId, actor_id AS actorId, actor_name AS actorName,
              type, data, created_at AS createdAt
         FROM activities WHERE lead_id = ? ORDER BY id DESC`,
      [leadId],
    )
    .map((row) => ({ ...row, data: JSON.parse(row.data) }));
}

/* ------------------------------------------------------------ reads */

export function getLead(id) {
  return shape(q.get(`${SELECT} WHERE l.id = ?`, [id]));
}

export function listLeads(user, filters = {}) {
  const where = [];
  const params = [];

  if (!isAdmin(user)) {
    where.push('(l.assignee_id = ? OR l.assignee_id IS NULL)');
    params.push(user.id);
  }
  if (filters.status) {
    where.push('l.status = ?');
    params.push(filters.status);
  }
  if (filters.assignee === 'unassigned') {
    where.push('l.assignee_id IS NULL');
  } else if (typeof filters.assignee === 'number') {
    where.push('l.assignee_id = ?');
    params.push(filters.assignee);
  }
  if (filters.q) {
    where.push('(l.name LIKE ? OR l.email LIKE ? OR l.company LIKE ?)');
    const like = `%${filters.q}%`;
    params.push(like, like, like);
  }
  if (filters.createdAfter) {
    where.push('l.created_at >= ?');
    params.push(filters.createdAfter);
  }
  if (filters.createdBefore) {
    where.push('l.created_at <= ?');
    params.push(filters.createdBefore);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = q.get(`SELECT COUNT(*) AS n FROM leads l ${clause}`, params).n;

  const page = filters.page || 1;
  const perPage = filters.perPage || 20;
  const sortCol = SORTABLE[filters.sort || 'created_at'];
  const order = filters.order === 'asc' ? 'ASC' : 'DESC';
  const rows = q.all(`${SELECT} ${clause} ORDER BY ${sortCol} ${order}, l.id ${order} LIMIT ? OFFSET ?`, [
    ...params,
    perPage,
    (page - 1) * perPage,
  ]);

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  return {
    data: rows.map(shape),
    meta: { page, perPage, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export function statusCounts(user) {
  const scoped = isAdmin(user) ? '' : 'WHERE (assignee_id = ? OR assignee_id IS NULL)';
  const params = isAdmin(user) ? [] : [user.id];
  const rows = q.all(`SELECT status, COUNT(*) AS n FROM leads ${scoped} GROUP BY status`, params);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of rows) counts[row.status] = row.n;
  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  return counts;
}

/* ------------------------------------------------------------ writes */

export function createLead(payload, actor = null, { source = 'web_form' } = {}) {
  const ts = nowIso();
  return q.tx(() => {
    const { lastInsertRowid } = q.run(
      `INSERT INTO leads (name, email, phone, company, source, message, value_cents, status, assignee_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        payload.name,
        payload.email,
        payload.phone ?? null,
        payload.company ?? null,
        payload.source ?? source,
        payload.message ?? null,
        payload.valueCents ?? null,
        'new',
        payload.assigneeId ?? null,
        ts,
        ts,
      ],
    );
    recordActivity(lastInsertRowid, actor, 'lead.created', { source: payload.source ?? source });
    if (payload.assigneeId) {
      const target = findUserById(payload.assigneeId);
      recordActivity(lastInsertRowid, actor, 'lead.assigned', {
        assigneeId: payload.assigneeId,
        assigneeName: target?.name ?? null,
      });
    }
    return getLead(lastInsertRowid);
  });
}

export function updateLead(lead, changes, actor) {
  const sets = [];
  const params = [];
  const touched = {};

  for (const field of ['name', 'email', 'phone', 'company', 'message']) {
    if (changes[field] !== undefined && changes[field] !== lead[field]) {
      sets.push(`${field} = ?`);
      params.push(changes[field]);
      touched[field] = changes[field];
    }
  }
  if (changes.valueCents !== undefined && changes.valueCents !== lead.valueCents) {
    sets.push('value_cents = ?');
    params.push(changes.valueCents);
    touched.valueCents = changes.valueCents;
  }

  const statusChange =
    changes.status !== undefined && changes.status !== lead.status ? changes.status : null;

  if (statusChange) {
    assertTransitionAllowed(lead.status, statusChange, actor);
    sets.push('status = ?');
    params.push(statusChange);
  }

  if (sets.length === 0) return lead;

  return q.tx(() => {
    sets.push('updated_at = ?');
    params.push(nowIso(), lead.id);
    q.run(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`, params);

    if (Object.keys(touched).length > 0) {
      recordActivity(lead.id, actor, 'lead.updated', { fields: Object.keys(touched) });
    }
    if (statusChange) {
      recordActivity(lead.id, actor, 'lead.status_changed', { from: lead.status, to: statusChange });
    }
    return getLead(lead.id);
  });
}

export function assertTransitionAllowed(from, to, actor) {
  if (!STATUSES.includes(to)) {
    throw errors.unprocessable({ status: `Must be one of: ${STATUSES.join(', ')}.` });
  }
  if (from === to) return;
  if (TRANSITIONS[from].includes(to)) return;
  if (isAdmin(actor) && (ADMIN_ONLY_TRANSITIONS[from] || []).includes(to)) return;

  const allowed = [...TRANSITIONS[from], ...(isAdmin(actor) ? ADMIN_ONLY_TRANSITIONS[from] || [] : [])];
  throw errors.conflict(`A lead cannot move from "${from}" to "${to}".`, {
    from,
    to,
    allowed,
  });
}

export function assignLead(lead, assigneeId, actor) {
  if (assigneeId !== null) {
    const target = findUserById(assigneeId);
    if (!target || !target.isActive) {
      throw errors.unprocessable({ assigneeId: 'That user does not exist or is deactivated.' });
    }
  }
  if (!isAdmin(actor)) {
    if (assigneeId !== actor.id) {
      throw errors.forbidden('Members can only claim leads for themselves.');
    }
    if (lead.assigneeId !== null && lead.assigneeId !== actor.id) {
      throw errors.forbidden('That lead is already claimed by someone else.');
    }
  }
  if (lead.assigneeId === assigneeId) return lead;

  return q.tx(() => {
    q.run('UPDATE leads SET assignee_id = ?, updated_at = ? WHERE id = ?', [
      assigneeId,
      nowIso(),
      lead.id,
    ]);
    if (assigneeId === null) {
      recordActivity(lead.id, actor, 'lead.unassigned', { previousAssigneeId: lead.assigneeId });
    } else {
      const target = findUserById(assigneeId);
      recordActivity(lead.id, actor, 'lead.assigned', {
        assigneeId,
        assigneeName: target.name,
        previousAssigneeId: lead.assigneeId,
      });
    }
    return getLead(lead.id);
  });
}

export function deleteLead(lead, actor) {
  recordActivity(lead.id, actor, 'lead.deleted', { name: lead.name });
  q.run('DELETE FROM leads WHERE id = ?', [lead.id]);
}

/* ------------------------------------------------------------ notes */

export function addNote(leadId, body, author) {
  return q.tx(() => {
    const ts = nowIso();
    const { lastInsertRowid } = q.run(
      'INSERT INTO notes (lead_id, author_id, body, created_at) VALUES (?,?,?,?)',
      [leadId, author.id, body, ts],
    );
    q.run('UPDATE leads SET updated_at = ? WHERE id = ?', [ts, leadId]);
    recordActivity(leadId, author, 'note.added', { noteId: lastInsertRowid });
    return getNote(lastInsertRowid);
  });
}

export function getNote(id) {
  return q.get(
    `SELECT n.id, n.lead_id AS leadId, n.body, n.created_at AS createdAt,
            n.author_id AS authorId, u.name AS authorName
       FROM notes n LEFT JOIN users u ON u.id = n.author_id
      WHERE n.id = ?`,
    [id],
  );
}

export function listNotes(leadId) {
  return q.all(
    `SELECT n.id, n.lead_id AS leadId, n.body, n.created_at AS createdAt,
            n.author_id AS authorId, u.name AS authorName
       FROM notes n LEFT JOIN users u ON u.id = n.author_id
      WHERE n.lead_id = ? ORDER BY n.id DESC`,
    [leadId],
  );
}
