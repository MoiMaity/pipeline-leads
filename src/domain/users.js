import { q, nowIso } from '../lib/db.js';
import { hashPassword, verifyPassword } from '../lib/auth.js';
import { errors } from '../lib/http.js';

export const ROLES = ['admin', 'member'];

const PUBLIC_FIELDS = 'id, email, name, role, is_active AS isActive, created_at AS createdAt';

export function listUsers({ includeInactive = true } = {}) {
  const where = includeInactive ? '' : 'WHERE is_active = 1';
  return q
    .all(`SELECT ${PUBLIC_FIELDS} FROM users ${where} ORDER BY role ASC, name ASC`)
    .map(normalize);
}

export function findUserById(id) {
  const row = q.get(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`, [id]);
  return row ? normalize(row) : null;
}

export function findUserByEmail(email) {
  return q.get('SELECT * FROM users WHERE email = ?', [String(email).toLowerCase()]);
}

export function createUser({ email, name, role, password }) {
  if (findUserByEmail(email)) {
    throw errors.conflict('An account with that email already exists.', { email: 'Already in use.' });
  }
  const { lastInsertRowid } = q.run(
    'INSERT INTO users (email, name, role, password_hash, is_active, created_at) VALUES (?,?,?,?,1,?)',
    [String(email).toLowerCase(), name, role, hashPassword(password), nowIso()],
  );
  return findUserById(lastInsertRowid);
}

export function setUserActive(id, active) {
  const changed = q.run('UPDATE users SET is_active = ? WHERE id = ?', [active ? 1 : 0, id]).changes;
  if (!changed) throw errors.notFound('User not found.');
  return findUserById(id);
}

export function authenticate(email, password) {
  const row = findUserByEmail(email);
  if (!row || !row.is_active) {
    // Constant-ish work either way so timing does not reveal whether the email exists.
    verifyPassword(password, 'scrypt$16384$8$1$AAAA$AAAA');
    return null;
  }
  if (!verifyPassword(password, row.password_hash)) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

function normalize(row) {
  return { ...row, isActive: Boolean(row.isActive) };
}
