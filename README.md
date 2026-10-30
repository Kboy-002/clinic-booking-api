# Greenfield Clinic — Booking API + web page

Task 1 of the Koya Cohort 4 assessment: an API that lets patients book
appointment slots, plus a simple web page that uses it.

- **Live site (web page + API):** `https://<your-app>.onrender.com`
- **API key:** `clinic-1a2922744d69fff2b598f9275b1b3ba52d55f17b4711c95e`
  (sent on every request as the `X-API-Key` header)

## Endpoints

Everything is JSON. Every error response is `{"error": "<message>"}`. Every
request needs the `X-API-Key` header; a missing or wrong key returns **401**.

| Method & path | What it does |
| --- | --- |
| `POST /reset` | Deletes every booking and replaces all slots with the ones you send (past slots allowed). Body: `{"slots": [{id, provider, start, end}, ...]}` |
| `GET /slots` | Every slot, earliest `start` first, each with `available` (`false` while the slot has a confirmed booking). Optional `?provider=` exact-match filter |
| `POST /bookings` | Books a slot. Body: `{slot_id, name, email}` → **201** with the booking. **400** missing/empty/invalid field or the slot has already started · **404** unknown slot · **409** slot already booked · **429** rate limited (with `Retry-After`) · **422** `Idempotency-Key` reused with a different body |
| `GET /bookings?email=&limit=&cursor=` | That person's bookings (case-insensitive email), oldest first, cursor-paged. `limit` 1–50 (default 10). Last page has `next_cursor: null` |
| `GET /bookings/{id}` | One booking, or **404** |
| `DELETE /bookings/{id}` | Cancels the booking (`status: cancelled`, slot freed). **404** unknown · **409** already cancelled |

Extra: `GET /` serves the web page, `GET /health` is a plain liveness check.

## Levels covered

- **Level 1** — list slots, book one, look up a booking.
- **Level 2** — every request needs the API key; bookings with missing or
  invalid details are turned away. `name` and `email` are trimmed and `email`
  is stored lower-case. A slot that has already started cannot be booked.
- **Level 3** — a slot can hold only one confirmed booking even when many
  requests arrive at the exact same moment (enforced by a unique index in the
  database). Bookings can be cancelled, which frees the slot.
- **Level 4** — the optional `Idempotency-Key` header: the same key with the
  same body returns the same response (same status code, same booking `id`)
  and never creates a second booking, including under concurrency; the same
  key with a different body returns 422. `GET /bookings` pages with
  `next_cursor`/`cursor`.
- **Level 5** — at most 5 booking attempts per email per minute (failed
  attempts included); the 6th returns 429 with `Retry-After` in whole seconds.
  Other emails are unaffected.

## Design notes

- **Storage:** SQLite (via `better-sqlite3`) in a single file, so bookings
  survive between requests and process restarts.
- **Double bookings:** a partial unique index on `bookings(slot_id) WHERE
  status = 'confirmed'` makes the database itself the tiebreaker; losing a
  race yields 409. Request handlers are synchronous so check and insert are
  one atomic step per process as well.
- **Idempotency:** each key stores a hash of the requested booking plus the
  recorded response; retries replay it byte-for-byte. Only attempts that reach
  booking processing are rate-counted; pure idempotent replays are lookups.
- **Pagination:** keyset (cursor) over `(created_at, id)`, stable even while
  new bookings appear. `created_at` is strictly increasing per process.
- **Timestamps:** slot `start`/`end` are echoed back exactly as sent in
  `/reset`; only parsed values are used for sorting and the "already started"
  check.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

Configuration (environment variables, all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `API_KEY` | built-in key above | Value accepted in `X-API-Key` |
| `DATA_DIR` / `DB_PATH` | `./data` | Where the SQLite file lives |

## Tests

```bash
npm test                                   # spins up a local server + fresh DB
BASE_URL=https://<your-app>.onrender.com \
API_KEY=clinic-1a2922744d69fff2b598f9275b1b3ba52d55f17b4711c95e \
npm test                                   # same suite against the deployment
```

The suite covers all five levels, including 15 simultaneous bookings for one
slot, concurrent retries carrying one `Idempotency-Key`, cursor pagination and
the 6th-attempt 429.

## Deployment (Render free tier)

The service is a single Node web process; `render.yaml` describes it for
Render Blueprints. The `.github/workflows/keep-warm.yml` workflow pings
`/health` every 10 minutes so the free instance never sleeps and answers
instantly.

One caveat of the free tier: the instance's filesystem is not a persistent
disk, so the SQLite file lives as long as the instance does. The keep-warm
ping holds the instance open, and `npm run dev` + the tests make it easy to
restore from scratch if the instance is ever recycled.
