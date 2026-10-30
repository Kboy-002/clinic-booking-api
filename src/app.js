'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');

const API_KEY = process.env.API_KEY || 'clinic-1a2922744d69fff2b598f9275b1b3ba52d55f17b4711c95e';
const RATE_LIMIT = 5;              // level 5: attempts per email per minute
const RATE_WINDOW_MS = 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// helpers

function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: row.created_at,
  };
}

function encodeCursor(row) {
  const payload = Buffer.from(JSON.stringify({ t: row.created_at, i: row.id }), 'utf8');
  return payload.toString('base64url');
}

function decodeCursor(raw) {
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (parsed && typeof parsed.t === 'string' && typeof parsed.i === 'string') {
      return { t: parsed.t, i: parsed.i };
    }
  } catch (_) { /* fall through */ }
  return null;
}

// Canonical hash of the booking a request asks for. Two requests carrying the
// same Idempotency-Key and the same booking details hash the same, so the
// second one replays instead of booking again.
function hashRequest(body) {
  const canonical = JSON.stringify({
    slot_id: typeof body.slot_id === 'string' ? body.slot_id.trim() : null,
    name: typeof body.name === 'string' ? body.name.trim() : null,
    email: typeof body.email === 'string' ? body.email.trim().toLowerCase() : null,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function keyMatches(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Strictly increasing created_at values so "oldest first" ordering is stable
// even when several bookings are created within the same millisecond.
let lastCreatedAtMs = 0;
function monotonicIsoNow() {
  const now = Date.now();
  lastCreatedAtMs = now > lastCreatedAtMs ? now : lastCreatedAtMs + 1;
  return new Date(lastCreatedAtMs).toISOString();
}

// ---------------------------------------------------------------------------
// app

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // CORS so the web page can call the API from anywhere; OPTIONS is answered
  // without an API key because browsers never send one on a preflight.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Idempotency-Key');
    res.set('Access-Control-Expose-Headers', 'Retry-After');
    res.set('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Level 2: every API request must carry the API key.
  const requireKey = (req, res, next) => {
    const given = req.get('X-API-Key');
    if (!given || !keyMatches(given, API_KEY)) {
      return res.status(401).json({ error: 'missing or invalid API key' });
    }
    next();
  };

  // -------------------------------------------------------------------------
  // web page + health (no key needed)

  const indexHtml = fs
    .readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
    .split('__API_KEY__')
    .join(API_KEY);

  app.get('/', (req, res) => res.type('html').send(indexHtml));
  app.get('/health', (req, res) => res.json({ ok: true }));

  // -------------------------------------------------------------------------
  // POST /reset - level 1: delete every booking and replace all slots

  app.post('/reset', requireKey, (req, res) => {
    const body = req.body;
    if (!body || !Array.isArray(body.slots)) {
      return res.status(400).json({ error: 'slots array is required' });
    }

    const prepared = [];
    for (const slot of body.slots) {
      if (!slot || typeof slot.id !== 'string' || slot.id.trim() === '') {
        return res.status(400).json({ error: 'each slot needs a non-empty id' });
      }
      if (typeof slot.provider !== 'string') {
        return res.status(400).json({ error: 'each slot needs a provider' });
      }
      const startMs = Date.parse(slot.start);
      const endMs = Date.parse(slot.end);
      if (typeof slot.start !== 'string' || Number.isNaN(startMs) ||
          typeof slot.end !== 'string' || Number.isNaN(endMs)) {
        return res.status(400).json({ error: 'each slot needs a valid start and end' });
      }
      prepared.push({ id: slot.id.trim(), provider: slot.provider, start_raw: slot.start, end_raw: slot.end, start_ms: startMs });
    }

    db.transaction(() => {
      db.prepare('DELETE FROM bookings').run();
      db.prepare('DELETE FROM idempotency').run();
      db.prepare('DELETE FROM rate_attempts').run();
      db.prepare('DELETE FROM slots').run();
      const insert = db.prepare(
        'INSERT INTO slots (id, provider, start_raw, end_raw, start_ms) VALUES (@id, @provider, @start_raw, @end_raw, @start_ms)' +
        ' ON CONFLICT(id) DO UPDATE SET provider = @provider, start_raw = @start_raw, end_raw = @end_raw, start_ms = @start_ms'
      );
      for (const slot of prepared) insert.run(slot);
    })();

    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // GET /slots - level 1: every slot, earliest start first

  app.get('/slots', requireKey, (req, res) => {
    const byProvider = typeof req.query.provider === 'string';
    const sql =
      'SELECT s.id, s.provider, s.start_raw, s.end_raw, ' +
      "       EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS taken " +
      'FROM slots s' +
      (byProvider ? ' WHERE s.provider = ?' : '') +
      ' ORDER BY s.start_ms ASC, s.id ASC';
    const rows = byProvider ? db.prepare(sql).all(req.query.provider) : db.prepare(sql).all();

    res.json({
      slots: rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        start: r.start_raw,
        end: r.end_raw,
        available: !r.taken,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // POST /bookings - levels 1-5

  app.post('/bookings', requireKey, (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const idemKeyRaw = req.get('Idempotency-Key');
    const idemKey = typeof idemKeyRaw === 'string' ? idemKeyRaw.trim() : '';

    // Level 4: a known key either replays its recorded response or, if it now
    // carries a different request, is refused with 422. Replays book nothing
    // and are not counted as fresh attempts.
    let requestHash = null;
    if (idemKey) {
      requestHash = hashRequest(body);
      const recorded = db.prepare('SELECT * FROM idempotency WHERE key = ?').get(idemKey);
      if (recorded) {
        if (recorded.request_hash !== requestHash) {
          return res.status(422).json({ error: 'Idempotency-Key reused with a different body' });
        }
        res.set('Idempotency-Replayed', 'true');
        return res.status(recorded.status_code).type('json').send(recorded.response_body);
      }
    }

    // Level 5: at most 5 attempts per email per minute. Failures count, so the
    // attempt is logged before any validation runs.
    const emailKey = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (emailKey) {
      const now = Date.now();
      db.prepare('DELETE FROM rate_attempts WHERE attempted_at < ?').run(now - RATE_WINDOW_MS);
      const window = db
        .prepare('SELECT attempted_at FROM rate_attempts WHERE email = ? AND attempted_at >= ? ORDER BY attempted_at ASC')
        .all(emailKey, now - RATE_WINDOW_MS);
      if (window.length >= RATE_LIMIT) {
        const retryAfter = Math.max(1, Math.ceil((window[0].attempted_at + RATE_WINDOW_MS - now) / 1000));
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'too many booking attempts for this email' });
      }
      db.prepare('INSERT INTO rate_attempts (email, attempted_at) VALUES (?, ?)').run(emailKey, now);
    }

    const outcome = createBooking(body);

    // Level 4: record what happened (including refusals) so an honest retry
    // with the same key gets the same answer back.
    if (idemKey) {
      try {
        db.prepare('INSERT INTO idempotency (key, request_hash, status_code, response_body, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(idemKey, requestHash, outcome.status, JSON.stringify(outcome.payload), new Date().toISOString());
      } catch (_) { /* a concurrent duplicate key is fine: its response is recorded by the winner */ }
    }

    res.status(outcome.status).json(outcome.payload);
  });

  // Level 2 + 3 booking rules. Synchronous on purpose: with a synchronous
  // SQLite driver the check and the insert run as one atomic step per process,
  // on top of the database's own unique index.
  function createBooking(body) {
    const slotId = typeof body.slot_id === 'string' ? body.slot_id.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

    if (!slotId) return { status: 400, payload: { error: 'slot_id is required' } };
    if (!name) return { status: 400, payload: { error: 'name is required' } };
    if (!email) return { status: 400, payload: { error: 'email is required' } };
    if (!EMAIL_RE.test(email)) return { status: 400, payload: { error: 'email is invalid' } };

    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId);
    if (!slot) return { status: 404, payload: { error: 'slot not found' } };

    if (Date.now() >= slot.start_ms) {
      return { status: 400, payload: { error: 'the slot has already started' } };
    }

    const taken = db
      .prepare("SELECT 1 FROM bookings WHERE slot_id = ? AND status = 'confirmed'")
      .get(slotId);
    if (taken) return { status: 409, payload: { error: 'slot already booked' } };

    const id = 'b_' + crypto.randomUUID();
    const createdAt = monotonicIsoNow();
    try {
      db.prepare('INSERT INTO bookings (id, slot_id, name, email, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, slotId, name, email, 'confirmed', createdAt);
    } catch (err) {
      // Same-moment double booking: the unique index is the tiebreaker.
      if (String(err && err.message).includes('UNIQUE constraint failed')) {
        return { status: 409, payload: { error: 'slot already booked' } };
      }
      throw err;
    }

    return { status: 201, payload: { id, slot_id: slotId, name, email, status: 'confirmed', created_at: createdAt } };
  }

  // -------------------------------------------------------------------------
  // GET /bookings - level 4: one person's bookings, oldest first, cursor paged

  app.get('/bookings', requireKey, (req, res) => {
    const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
    if (!email) return res.status(400).json({ error: 'email is required' });

    let limit = 10;
    const limitRaw = req.query.limit;
    if (limitRaw !== undefined && limitRaw !== '') {
      const asString = String(limitRaw).trim();
      if (!/^\d+$/.test(asString)) return res.status(400).json({ error: 'limit must be an integer between 1 and 50' });
      limit = parseInt(asString, 10);
      if (limit < 1 || limit > 50) return res.status(400).json({ error: 'limit must be an integer between 1 and 50' });
    }

    let cursor = null;
    if (req.query.cursor !== undefined && req.query.cursor !== '') {
      cursor = decodeCursor(req.query.cursor);
      if (!cursor) return res.status(400).json({ error: 'invalid cursor' });
    }

    const params = [email];
    let sql = 'SELECT * FROM bookings WHERE email = ?';
    if (cursor) {
      sql += ' AND (created_at > ? OR (created_at = ? AND id > ?))';
      params.push(cursor.t, cursor.t, cursor.i);
    }
    sql += ' ORDER BY created_at ASC, id ASC LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(sql).all(...params);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    res.json({
      bookings: page.map(toBooking),
      next_cursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    });
  });

  // -------------------------------------------------------------------------
  // GET /bookings/:id - level 1

  app.get('/bookings/:id', requireKey, (req, res) => {
    const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'booking not found' });
    res.json(toBooking(row));
  });

  // -------------------------------------------------------------------------
  // DELETE /bookings/:id - level 3: cancel, which frees the slot

  app.delete('/bookings/:id', requireKey, (req, res) => {
    const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'booking not found' });
    if (row.status === 'cancelled') return res.status(409).json({ error: 'booking is already cancelled' });

    db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run('cancelled', row.id);
    res.json(toBooking({ ...row, status: 'cancelled' }));
  });

  // -------------------------------------------------------------------------

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'request body is not valid JSON' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'request body is too large' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createApp, API_KEY };
