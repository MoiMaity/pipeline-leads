# Pipeline — a lead platform

A lead management application for a small sales team: a public capture form, an
authenticated app with two roles, a lifecycle that records who did what, and a JSON API.

- **Live app:** `<paste your deployment URL here>`
- **Public capture form:** `<deployment URL>/`
- **Team sign in:** `<deployment URL>/login`
- **API base:** `<deployment URL>/api`

Built on Node 22 with **zero runtime dependencies** — `node:http` for the server,
`node:sqlite` for storage, `node:crypto` for password hashing, `node:test` for the suite.
There is no build step and no `npm install`: clone it, seed it, run it.

---

## Demo credentials

| Role   | Email                  | Password          | What they can do                          |
| ------ | ---------------------- | ----------------- | ----------------------------------------- |
| Admin  | `admin@pipeline.test`  | `AdminPass!2026`  | Everything, including the team page        |
| Member | `rosa@pipeline.test`   | `MemberPass!2026` | Her own leads plus the unclaimed pool      |
| Member | `kwame@pipeline.test`  | `MemberPass!2026` | His own leads plus the unclaimed pool      |

Rosa and Kwame each own leads the other cannot see — sign in as both to watch the
permission boundary hold.

---

## Run it locally

Requires Node 22.5 or newer (for the built-in SQLite module). Nothing else.

```bash
git clone <your repo url> && cd pipeline
node --version          # v22.5.0 or newer
npm run seed            # creates ./data/app.db with demo accounts and sample leads
npm start               # http://localhost:3000
npm test                # 49 tests, no network or services required
```

`npm run reset` rebuilds the sample leads from scratch. `npm run dev` restarts on change.

---

## Roles and permissions

Two roles, enforced in three places: the server refuses the request, the server
declines to render the control, and the client script strips anything marked
`data-requires-role` that does not match the signed-in user. The server is the
authority; the other two exist so nobody is shown a button that will fail.

| Action                            | Admin | Member                              |
| --------------------------------- | :---: | ----------------------------------- |
| See every lead                    |  yes  | own leads + unclaimed pool only     |
| See a lead owned by someone else  |  yes  | **no — returns 404, not 403**       |
| Create a lead by hand             |  yes  | yes (assigned to self or unclaimed) |
| Edit / move a lead                |  yes  | only leads they own                 |
| Claim an unclaimed lead           |  yes  | yes                                 |
| Assign a lead to another person   |  yes  | no (403)                            |
| Reopen a won or lost lead         |  yes  | no (409)                            |
| Delete a lead                     |  yes  | no (403)                            |
| List / create / deactivate users  |  yes  | no (403)                            |

**Why 404 and not 403 for another member's lead.** Answering 403 confirms the record
exists. For leads owned by another member the API answers 404, so a member cannot
enumerate the team's book of business. Where the resource *is* visible but the action
is not allowed (editing an unclaimed lead, deleting anything), the answer is a
straightforward 403 with a message that says what to do instead.

---

## Lead lifecycle

```
new ──► contacted ──► qualified ──► proposal ──► won
 │           │             │            │
 └───────────┴─────────────┴────────────┴──────► lost
                                                  │
                          admin only: lost ──► contacted,  won ──► proposal
```

- Stages move one step at a time. Skipping is a **409** that tells you which moves are legal.
- Anyone who owns the lead can drop it to `lost`.
- `won` and `lost` are terminal for members. Only an admin reopens them.
- **Notes** are timestamped, attributed, and never editable.
- **Every** mutation writes an activity row: created, assigned, unassigned, status
  changed, updated, note added, deleted. The trail records the actor — including
  `Public form` for enquiries that arrive with no signed-in user.

---

## API documentation

Base path `/api`. Requests and responses are JSON. Successful reads and writes return
`{ "data": ... }`; list endpoints add `{ "meta": ... }`; failures return
`{ "error": { "code", "message", "details?" } }`.

### Authenticating

Two ways in, both backed by the same session record:

1. **Bearer token** — `POST /api/auth/login` returns a token; send
   `Authorization: Bearer <token>`. This is the path for scripts and curl.
2. **Session cookie** — the same call sets an `HttpOnly; SameSite=Lax` cookie for the
   browser app. Cookie-authenticated **writes** must also send `X-CSRF-Token` with the
   `csrfToken` from the login response, otherwise they are rejected with 403.

Sessions last 12 hours. Deactivating a user invalidates their sessions immediately.

```bash
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@pipeline.test","password":"AdminPass!2026"}' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

curl -s "$BASE/api/leads?status=new&per_page=5" -H "Authorization: Bearer $TOKEN"
```

### Endpoints

| Method | Path                       | Auth   | Purpose                                       |
| ------ | -------------------------- | ------ | --------------------------------------------- |
| POST   | `/api/public/leads`        | none   | Public capture form. Rate limited, honeypotted |
| POST   | `/api/auth/login`          | none   | Sign in; returns token + csrf token            |
| POST   | `/api/auth/logout`         | any    | Destroy the current session                    |
| GET    | `/api/auth/me`             | any    | Current user                                   |
| GET    | `/api/leads`               | any    | List leads — paginated, filterable, scoped     |
| POST   | `/api/leads`               | any    | Create a lead by hand                          |
| GET    | `/api/leads/:id`           | any    | One lead, with the caller's permissions on it  |
| PATCH  | `/api/leads/:id`           | owner  | Edit fields and/or move the stage              |
| DELETE | `/api/leads/:id`           | admin  | Delete a lead and its notes and trail          |
| POST   | `/api/leads/:id/assign`    | rules  | Assign or unassign (`{"assigneeId": 3 \| null}`) |
| GET    | `/api/leads/:id/notes`     | any    | Notes, newest first                            |
| POST   | `/api/leads/:id/notes`     | owner  | Add a note                                     |
| GET    | `/api/leads/:id/activity`  | any    | Activity trail, newest first                   |
| GET    | `/api/stats`               | any    | Lead counts by stage, scoped to the caller     |
| GET    | `/api/users`               | admin  | List the team                                  |
| POST   | `/api/users`               | admin  | Create an account                              |
| PATCH  | `/api/users/:id`           | admin  | Activate or deactivate (`{"isActive": false}`) |

"owner" means an admin, or the member the lead is assigned to. Full request and
response examples for every endpoint are in [`docs/API.md`](docs/API.md).

### Listing leads

`GET /api/leads` accepts:

| Parameter        | Values                                          | Default      |
| ---------------- | ----------------------------------------------- | ------------ |
| `page`           | integer ≥ 1                                     | `1`          |
| `per_page`       | integer 1–100 (values above 100 are clamped)     | `20`         |
| `status`         | `new` `contacted` `qualified` `proposal` `won` `lost` | any     |
| `assignee_id`    | a user id, `me`, or `unassigned`                | any          |
| `q`              | substring match on name, email, company         | —            |
| `created_after`  | ISO 8601 timestamp                              | —            |
| `created_before` | ISO 8601 timestamp                              | —            |
| `sort`           | `created_at` `updated_at` `name` `status`       | `created_at` |
| `order`          | `asc` `desc`                                    | `desc`       |

```json
{
  "data": [
    {
      "id": 12,
      "name": "Priya Raman",
      "email": "priya@northgate.io",
      "phone": "+1 415 555 0142",
      "company": "Northgate Logistics",
      "source": "web_form",
      "message": "Forty trucks, all tracked in spreadsheets.",
      "valueCents": 480000,
      "status": "qualified",
      "assigneeId": 2,
      "assignee": { "id": 2, "name": "Rosa Iyer", "email": "rosa@pipeline.test" },
      "createdAt": "2026-07-20T09:14:02.145Z",
      "updatedAt": "2026-07-22T16:02:51.900Z"
    }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 34, "totalPages": 2, "hasNext": true, "hasPrev": false }
}
```

Scoping happens before pagination, so `meta.total` is always the number of leads *this
caller* can see. Requesting a page past the end returns an empty array, not an error.

### Status codes

| Code | When                                                                       |
| ---- | -------------------------------------------------------------------------- |
| 200  | Read or update succeeded                                                    |
| 201  | Created — includes a `Location` header                                      |
| 204  | Deleted or signed out; no body                                              |
| 400  | Malformed JSON, or a query parameter of the wrong type                      |
| 401  | Missing, expired, or invalid credentials                                    |
| 403  | Authenticated but not allowed — including a missing CSRF token              |
| 404  | No such record, or a record this caller is not permitted to know exists     |
| 405  | Path exists, method does not — includes an `Allow` header                   |
| 409  | The request conflicts with current state: illegal stage move, duplicate email |
| 422  | Validation failed — `details` maps each field to its problem                |
| 429  | Rate limit hit — includes `Retry-After` in seconds                          |
| 500  | Unexpected server error; the message never leaks internals                  |

The 400-versus-422 split is deliberate: a malformed *request* is a 400, a well-formed
request with unacceptable *values* is a 422 with per-field detail the UI renders inline.

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Some fields need attention.",
    "details": { "email": "Enter a valid email address.", "name": "Must be at least 2 characters." }
  }
}
```

---

## Tests

```bash
npm test
```

49 tests across three files, using the built-in runner against a real HTTP server on an
ephemeral port and an in-memory database. No mocks, no fixtures to maintain, no services
to start.

| File                            | Covers                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/auth.test.js`            | Sign-in and rejection, token invalidation on sign-out, 401 on every private endpoint, member-versus-admin boundaries, cross-member isolation, CSRF on cookie writes, instant lockout on deactivation |
| `tests/lead-lifecycle.test.js`  | **Flow 1:** public capture → admin assigns → owner works it to won → note added → the full activity trail is asserted event by event. **Flow 2:** illegal stage moves, dropping to lost, admin-only reopen, unassign, cascading delete |
| `tests/api-contract.test.js`    | Pagination across page boundaries, `per_page` clamping, every filter and the combinations, sorting, and one assertion per status code the API can return          |

CI runs the suite plus a boot check on every push — `.github/workflows/ci.yml`.

---

## Deploying

The image has no dependencies to install, so a deploy is a copy of the source onto
`node:22-alpine`. Seeding runs at boot and is idempotent, so demo credentials always
exist.

**Fly.io** (recommended — the volume keeps your data across deploys):

```bash
fly launch --copy-config --no-deploy   # uses the committed fly.toml
fly volumes create pipeline_data --size 1 --region iad
fly deploy
fly open
```

**Render:** point a new Web Service at the repo, choose the Docker runtime, free plan —
`render.yaml` sets the rest. The free plan has no persistent disk, so the database resets
on redeploy; the boot-time seed means the app is never empty.

**Anywhere else:** `docker build -t pipeline . && docker run -p 3000:3000 -v $(pwd)/data:/data pipeline`.

Set `TRUST_PROXY=1` behind any TLS-terminating proxy so session cookies get the `Secure`
flag and rate limiting reads the forwarded client IP.

---

## How it is put together

```
src/
  server.js            entry point, graceful shutdown
  app.js               request pipeline: route → parse body → resolve auth → handle → format errors
  lib/http.js          router, body parsing, cookies, the error vocabulary
  lib/db.js            SQLite connection, schema, query helpers, transactions
  lib/auth.js          scrypt hashing, sessions, CSRF, requireUser / requireAdmin
  lib/validate.js      field validation that produces 422 details
  lib/ratelimit.js     fixed-window limiter for the public form and sign-in
  domain/leads.js      pipeline rules, visibility scoping, notes, activity — no HTTP in here
  domain/users.js      accounts and authentication
  routes/api.js        the JSON API
  routes/ui.js         server-rendered pages and static assets
  views/               HTML templates with escaping by default
  public/              stylesheet and the client script
```

Permission decisions live in `domain/leads.js` (`canView`, `canEdit`, `assertVisible`,
`assertEditable`) rather than being scattered through route handlers, so the API and the
server-rendered pages enforce exactly the same rules — the pages call the same functions.

**Security choices:** scrypt with per-password salts; session tokens from
`crypto.randomBytes` compared by lookup, never by string equality on a secret; timing-safe
password comparison; a constant-work path for unknown emails so sign-in does not reveal
which addresses exist; `HttpOnly` `SameSite=Lax` cookies; CSRF tokens on cookie-authenticated
writes; parameterised SQL everywhere; HTML escaped by default in the template layer
(`raw()` has to be asked for); a honeypot field and rate limiting on the public form;
`X-Content-Type-Options: nosniff` on every response.

**Design.** The interface is built around one signature element — the *stage rail*, a
chevron strip showing where a lead sits in the pipeline. It is the control on the detail
page (click a chevron to advance, illegal moves are disabled before you click) and a
five-tick mini version in each list row, so a person can scan the state of the whole book
without reading a word. Data — ids, timestamps, phone numbers, money — is set in
monospace throughout, because that is what it is. Deep violet carries the brand; the six
stages each own a colour used consistently in tags, ticks and the trail.

## What I would do next

- Move SQLite to Postgres when more than one instance is needed; the `q` helper in
  `lib/db.js` is the only thing that would change.
- Email notification on assignment (currently the trail is the only signal).
- Saved views and a CSV export — the filter layer already supports both.
- A proper migration runner. The schema is currently created idempotently at boot, which
  is fine for one table set but will not carry a second year of changes.
- Move the rate limiter to shared storage before scaling past one process.
