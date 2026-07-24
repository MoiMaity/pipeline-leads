# Pipeline API reference

Complete request and response detail for every endpoint. For conventions, status codes
and the permission model, see the [README](../README.md).

All examples assume:

```bash
BASE=http://localhost:3000
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@pipeline.test","password":"AdminPass!2026"}' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
AUTH="Authorization: Bearer $TOKEN"
JSON="Content-Type: application/json"
```

---

## Public

### `POST /api/public/leads`

No authentication. This is what the capture form posts to. Rate limited to 10 requests
per minute per IP. A non-empty `website` field is treated as a bot and silently accepted
without creating anything.

**Body**

| Field     | Type   | Required | Rules                  |
| --------- | ------ | -------- | ---------------------- |
| `name`    | string | yes      | 2–120 characters       |
| `email`   | string | yes      | valid address, ≤ 254   |
| `phone`   | string | no       | ≤ 40 characters        |
| `company` | string | no       | ≤ 160 characters       |
| `message` | string | no       | ≤ 2000 characters      |
| `website` | string | no       | honeypot — leave empty |

```bash
curl -X POST "$BASE/api/public/leads" -H "$JSON" -d '{
  "name": "Priya Raman",
  "email": "priya@northgate.io",
  "company": "Northgate Logistics",
  "message": "Forty trucks, all tracked in spreadsheets."
}'
```

**201**

```json
{ "data": { "id": 12, "status": "new", "createdAt": "2026-07-24T09:14:02.145Z" } }
```

The response deliberately carries nothing else — the public endpoint never exposes
assignment, internal notes or team structure.

**422** when a field is missing or malformed. **429** when the limit is hit, with
`Retry-After` in seconds.

---

## Authentication

### `POST /api/auth/login`

Rate limited to 10 attempts per 15 minutes per IP.

```bash
curl -X POST "$BASE/api/auth/login" -H "$JSON" \
  -d '{"email":"rosa@pipeline.test","password":"MemberPass!2026"}'
```

**200** — also sets `pipeline_session` as an `HttpOnly; SameSite=Lax` cookie
(plus `Secure` when `TRUST_PROXY=1`).

```json
{
  "data": {
    "user": { "id": 2, "email": "rosa@pipeline.test", "name": "Rosa Iyer", "role": "member" },
    "token": "9f3c…",
    "csrfToken": "WM1H…",
    "expiresAt": "2026-07-24T21:14:02.145Z"
  }
}
```

**401** `{"error":{"code":"unauthorized","message":"Email or password is incorrect."}}` —
identical for an unknown email and a wrong password.

### `POST /api/auth/logout`

**204.** Destroys the session server-side and clears the cookie. Safe to call without a
session.

### `GET /api/auth/me`

**200** `{ "data": { "user": {…}, "csrfToken": "…" } }` · **401** if not signed in.

---

## Leads

### `GET /api/leads`

Query parameters are documented in the README. Members are scoped to their own leads plus
the unclaimed pool; admins see everything.

```bash
curl -s "$BASE/api/leads?status=qualified&assignee_id=me&sort=updated_at&per_page=10" -H "$AUTH"
```

**200**

```json
{
  "data": [ { "id": 12, "name": "Priya Raman", "…": "…", "assignee": { "id": 2, "name": "Rosa Iyer", "email": "rosa@pipeline.test" } } ],
  "meta": { "page": 1, "perPage": 10, "total": 3, "totalPages": 1, "hasNext": false, "hasPrev": false }
}
```

**400** for a non-integer `page` / `per_page`, or an unrecognised `status`, `sort` or
`order`.

### `POST /api/leads`

Create a lead by hand. `source` defaults to `manual`.

| Field        | Type           | Required | Notes                                           |
| ------------ | -------------- | -------- | ----------------------------------------------- |
| `name`       | string         | yes      | 2–120 characters                                |
| `email`      | string         | yes      | valid address                                   |
| `phone`      | string         | no       |                                                 |
| `company`    | string         | no       |                                                 |
| `message`    | string         | no       |                                                 |
| `source`     | string         | no       | free text, e.g. `referral`, `conference`        |
| `valueCents` | integer \| null | no      | stored in cents to avoid float money            |
| `assigneeId` | integer \| null | no      | members may only pass their own id (else 403)   |

```bash
curl -X POST "$BASE/api/leads" -H "$AUTH" -H "$JSON" \
  -d '{"name":"Tom Beckett","email":"tom@harborworks.com","company":"Harborworks","valueCents":1250000}'
```

**201** with `Location: /api/leads/13` and the full lead as `data`.
**403** if a member tries to assign to someone else. **422** on validation failure.

### `GET /api/leads/:id`

**200** — the lead plus what this caller may do with it:

```json
{ "data": { "id": 12, "…": "…", "permissions": { "canEdit": true, "canDelete": false } } }
```

**404** if the lead does not exist *or* belongs to another member.

### `PATCH /api/leads/:id`

Send only the fields you are changing. At least one is required.

| Field                                     | Notes                                      |
| ----------------------------------------- | ------------------------------------------ |
| `name` `email` `phone` `company` `message` | same rules as create                       |
| `valueCents`                              | integer or null                            |
| `status`                                  | must be a legal move from the current stage |

```bash
curl -X PATCH "$BASE/api/leads/12" -H "$AUTH" -H "$JSON" -d '{"status":"qualified"}'
```

**200** with the updated lead.

**409** for an illegal stage move — the response names the legal ones:

```json
{
  "error": {
    "code": "conflict",
    "message": "A lead cannot move from \"new\" to \"won\".",
    "details": { "from": "new", "to": "won", "allowed": ["contacted", "lost"] }
  }
}
```

**403** if a member tries to edit an unclaimed lead (claim it first).
**422** for an unrecognised status value, or an empty body.

### `DELETE /api/leads/:id`

Admin only. Cascades to notes and activity.

**204** · **403** for members · **404** if it does not exist.

### `POST /api/leads/:id/assign`

```bash
curl -X POST "$BASE/api/leads/12/assign" -H "$AUTH" -H "$JSON" -d '{"assigneeId": 2}'
curl -X POST "$BASE/api/leads/12/assign" -H "$AUTH" -H "$JSON" -d '{"assigneeId": null}'
```

`assigneeId` is required; `null` returns the lead to the unclaimed pool.

- Admins may assign to anyone.
- Members may only claim an unclaimed lead for themselves — assigning to anyone else is
  **403**, and a lead already claimed by another member is **404**.
- **422** if the user id does not exist or the account is deactivated.

**200** with the updated lead.

---

## Notes

### `GET /api/leads/:id/notes`

**200** — newest first.

```json
{
  "data": [
    {
      "id": 7,
      "leadId": 12,
      "body": "Spoke for 20 minutes. Six dispatchers are the real users.",
      "authorId": 2,
      "authorName": "Rosa Iyer",
      "createdAt": "2026-07-22T16:02:51.900Z"
    }
  ]
}
```

### `POST /api/leads/:id/notes`

Body: `{ "body": "…" }`, 1–4000 characters. Requires edit rights on the lead.
Adding a note bumps the lead's `updatedAt` and writes a `note.added` activity row.

**201** with the created note · **403** on an unclaimed lead · **404** if not visible.

---

## Activity

### `GET /api/leads/:id/activity`

**200** — the immutable trail, newest first.

```json
{
  "data": [
    { "id": 31, "leadId": 12, "actorId": 2, "actorName": "Rosa Iyer", "type": "note.added", "data": { "noteId": 7 }, "createdAt": "2026-07-22T16:02:51.900Z" },
    { "id": 28, "leadId": 12, "actorId": 2, "actorName": "Rosa Iyer", "type": "lead.status_changed", "data": { "from": "contacted", "to": "qualified" }, "createdAt": "2026-07-22T15:41:10.001Z" },
    { "id": 24, "leadId": 12, "actorId": 1, "actorName": "Dana Whitfield", "type": "lead.assigned", "data": { "assigneeId": 2, "assigneeName": "Rosa Iyer", "previousAssigneeId": null }, "createdAt": "2026-07-21T08:12:00.000Z" },
    { "id": 22, "leadId": 12, "actorId": null, "actorName": "Public form", "type": "lead.created", "data": { "source": "web_form" }, "createdAt": "2026-07-20T09:14:02.145Z" }
  ]
}
```

| `type`                | `data`                                             |
| --------------------- | -------------------------------------------------- |
| `lead.created`        | `{ source }`                                       |
| `lead.assigned`       | `{ assigneeId, assigneeName, previousAssigneeId }` |
| `lead.unassigned`     | `{ previousAssigneeId }`                           |
| `lead.status_changed` | `{ from, to }`                                     |
| `lead.updated`        | `{ fields: [...] }`                                |
| `note.added`          | `{ noteId }`                                       |
| `lead.deleted`        | `{ name }`                                         |

`actorId` is `null` and `actorName` is `Public form` for enquiries that arrive without a
signed-in user.

---

## Stats

### `GET /api/stats`

**200** — counts scoped to what the caller can see.

```json
{ "data": { "new": 6, "contacted": 3, "qualified": 2, "proposal": 1, "won": 1, "lost": 1, "total": 14 } }
```

---

## Users

All admin only; members get **403**.

### `GET /api/users`

```json
{ "data": [ { "id": 1, "email": "admin@pipeline.test", "name": "Dana Whitfield", "role": "admin", "isActive": true, "createdAt": "2026-07-01T10:00:00.000Z" } ] }
```

### `POST /api/users`

| Field      | Rules                       |
| ---------- | --------------------------- |
| `name`     | 2–120 characters, required  |
| `email`    | valid, unique, required     |
| `password` | at least 10 characters      |
| `role`     | `admin` or `member`         |

**201** with `Location` · **409** if the email is taken · **422** on validation failure.

### `PATCH /api/users/:id`

Body: `{ "isActive": false }`. Deactivating invalidates that user's sessions on their next
request and takes them out of the assignment list; their existing leads keep their owner.

**200** · **409** if an admin tries to deactivate themselves · **404** if no such user.

---

## Health

### `GET /healthz`

**200** `ok` in plain text. No authentication, used by the platform health check.
