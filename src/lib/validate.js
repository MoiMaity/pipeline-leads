import { errors } from './http.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export class Check {
  constructor(input) {
    this.input = input || {};
    this.errors = {};
    this.out = {};
  }

  fail(field, message) {
    if (!this.errors[field]) this.errors[field] = message;
    return this;
  }

  string(field, { required = false, min = 0, max = 500, trim = true, as = field } = {}) {
    let v = this.input[field];
    if (v == null || v === '') {
      if (required) this.fail(field, 'This field is required.');
      else this.out[as] = v === '' ? null : undefined;
      return this;
    }
    if (typeof v !== 'string') return this.fail(field, 'Expected a string.');
    if (trim) v = v.trim();
    if (v.length < min) return this.fail(field, `Must be at least ${min} characters.`);
    if (v.length > max) return this.fail(field, `Must be ${max} characters or fewer.`);
    this.out[as] = v;
    return this;
  }

  email(field, { required = false } = {}) {
    this.string(field, { required, max: 254 });
    const v = this.out[field];
    if (typeof v === 'string' && !EMAIL_RE.test(v)) {
      delete this.out[field];
      return this.fail(field, 'Enter a valid email address.');
    }
    if (typeof v === 'string') this.out[field] = v.toLowerCase();
    return this;
  }

  enum(field, allowed, { required = false } = {}) {
    const v = this.input[field];
    if (v == null || v === '') {
      if (required) this.fail(field, 'This field is required.');
      return this;
    }
    if (!allowed.includes(v)) {
      return this.fail(field, `Must be one of: ${allowed.join(', ')}.`);
    }
    this.out[field] = v;
    return this;
  }

  integer(field, { required = false, min = null, max = null, nullable = false } = {}) {
    const v = this.input[field];
    if (v === null && nullable) {
      this.out[field] = null;
      return this;
    }
    if (v == null || v === '') {
      if (required) this.fail(field, 'This field is required.');
      return this;
    }
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!Number.isInteger(n)) return this.fail(field, 'Must be a whole number.');
    if (min != null && n < min) return this.fail(field, `Must be ${min} or more.`);
    if (max != null && n > max) return this.fail(field, `Must be ${max} or less.`);
    this.out[field] = n;
    return this;
  }

  /** Throws 422 with per-field details, otherwise returns the cleaned object. */
  result() {
    if (Object.keys(this.errors).length > 0) throw errors.unprocessable(this.errors);
    for (const key of Object.keys(this.out)) {
      if (this.out[key] === undefined) delete this.out[key];
    }
    return this.out;
  }
}

export const check = (input) => new Check(input);

/** Query-string parsing: a bad query param is a 400, not a 422. */
export function intParam(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER, name } = {}) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) throw errors.badRequest(`Query parameter "${name}" must be an integer.`);
  return Math.min(Math.max(n, min), max);
}

export function enumParam(value, allowed, name) {
  if (value == null || value === '') return null;
  if (!allowed.includes(value)) {
    throw errors.badRequest(`Query parameter "${name}" must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}
