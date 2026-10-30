import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Runs against a locally started server by default. Set BASE_URL and API_KEY
// to run the same suite against a deployed instance.

const remote = process.env.BASE_URL;
let server = null;
let base;
let key;

if (!remote) {
  process.env.DB_PATH = path.join(os.tmpdir(), `clinic-test-${Date.now()}-${process.pid}.db`);
  const { createApp, API_KEY } = await import('../src/app.js');
  key = API_KEY;
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
} else {
  base = remote.replace(/\/+$/, '');
  key = process.env.API_KEY;
  if (!key) throw new Error('set API_KEY when running against BASE_URL');
}

test.after(() => { if (server) server.close(); });

// ---------------------------------------------------------------------------
// helpers

const DAY = 24 * 60 * 60 * 1000;
const future = (days, h = 9) => new Date(Date.now() + days * DAY).toISOString().slice(0, 11) + String(h).padStart(2, '0') + ':00:00.000Z';
const past = (days, h = 9) => new Date(Date.now() - days * DAY).toISOString().slice(0, 11) + String(h).padStart(2, '0') + ':00:00.000Z';

function slotSet() {
  return [
    { id: 's1', provider: 'Dr Ade', start: future(3, 9), end: future(3, 10) },
    { id: 's2', provider: 'Dr Ade', start: future(4, 9), end: future(4, 10) },
    { id: 's3', provider: 'Dr Bola', start: future(3, 11), end: future(3, 12) },
    { id: 's4', provider: 'Dr Bola', start: past(3, 9), end: past(3, 10) },
  ];
}

function call(method, p, { body, headers = {}, key: useKey = key } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (useKey !== null) h['X-API-Key'] = useKey;
  return fetch(base + p, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function reset(slots = slotSet()) {
  const res = await call('POST', '/reset', { body: { slots } });
  assert.equal(res.status, 200);
}

let emailCounter = 0;
const uniqueEmail = (label = 'person') => `${label}-${++emailCounter}-${Date.now()}@example.com`;

// ---------------------------------------------------------------------------
// level 1

test('level 1: reset replaces slots, list is earliest-first with availability', async () => {
  await reset();
  const res = await call('GET', '/slots');
  assert.equal(res.status, 200);
  const { slots } = await res.json();
  assert.equal(slots.length, 4);

  // earliest start first
  const starts = slots.map((s) => Date.parse(s.start));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));

  // echo of stored fields is verbatim
  const s1 = slots.find((s) => s.id === 's1');
  assert.equal(s1.provider, 'Dr Ade');
  assert.equal(s1.start, slotSet()[0].start);
  assert.equal(s1.end, slotSet()[0].end);
  for (const s of slots) assert.equal(typeof s.available, 'boolean');

  // provider filter is an exact match
  const filtered = await (await call('GET', '/slots?provider=Dr%20Bola')).json();
  assert.deepEqual(filtered.slots.map((s) => s.id).sort(), ['s3', 's4']);
  const none = await (await call('GET', '/slots?provider=Dr%20Nobody')).json();
  assert.equal(none.slots.length, 0);
});

test('level 1: book a slot and look the booking up', async () => {
  await reset();
  const email = uniqueEmail('l1');
  const res = await call('POST', '/bookings', {
    body: { slot_id: 's1', name: 'Ada Obi', email },
  });
  assert.equal(res.status, 201);
  const booking = await res.json();
  assert.equal(booking.slot_id, 's1');
  assert.equal(booking.name, 'Ada Obi');
  assert.equal(booking.email, email);
  assert.equal(booking.status, 'confirmed');
  assert.ok(booking.id);
  assert.ok(!Number.isNaN(Date.parse(booking.created_at)));

  const got = await call('GET', `/bookings/${booking.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(await got.json(), booking);

  const missing = await call('GET', '/bookings/nope');
  assert.equal(missing.status, 404);
  assert.equal(typeof (await missing.json()).error, 'string');
});

test('reset validates its payload', async () => {
  const res = await call('POST', '/reset', { body: { nope: true } });
  assert.equal(res.status, 400);
  const res2 = await call('POST', '/reset', { body: { slots: [{ id: '' }] } });
  assert.equal(res2.status, 400);
  await reset();
});

// ---------------------------------------------------------------------------
// level 2

test('level 2: requests without the API key are refused', async () => {
  const noKey = await call('GET', '/slots', { key: null });
  assert.equal(noKey.status, 401);
  const wrongKey = await call('GET', '/slots', { key: 'wrong-key' });
  assert.equal(wrongKey.status, 401);
  const ok = await call('GET', '/slots');
  assert.equal(ok.status, 200);

  // every endpoint is protected
  assert.equal((await call('POST', '/bookings', { key: null, body: {} })).status, 401);
  assert.equal((await call('POST', '/reset', { key: 'x', body: { slots: [] } })).status, 401);
  assert.equal((await call('GET', '/bookings?email=a@b.co', { key: null })).status, 401);
  assert.equal((await call('DELETE', '/bookings/whatever', { key: null })).status, 401);
});

test('level 2: missing or invalid booking details are turned away', async () => {
  await reset();
  const cases = [
    { name: 'A B', email: uniqueEmail('l2') },                          // no slot_id
    { slot_id: 's1', email: uniqueEmail('l2') },                        // no name
    { slot_id: 's1', name: 'A B' },                  // no email
    { slot_id: '  ', name: 'A B', email: uniqueEmail('l2') },           // empty slot_id
    { slot_id: 's1', name: '   ', email: uniqueEmail('l2') },           // empty name
    { slot_id: 's1', name: 'A B', email: '   ' },    // empty email
    { slot_id: 's1', name: 'A B', email: 'not-an-email' },
    { slot_id: 's1', name: 'A B', email: 'a@b' },
  ];
  for (const body of cases) {
    const res = await call('POST', '/bookings', { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(typeof (await res.json()).error, 'string');
  }

  const unknown = await call('POST', '/bookings', {
    body: { slot_id: 's999', name: 'A B', email: uniqueEmail('l2') },
  });
  assert.equal(unknown.status, 404);

  const started = await call('POST', '/bookings', {
    body: { slot_id: 's4', name: 'A B', email: uniqueEmail('l2') }, // s4 starts in the past
  });
  assert.equal(started.status, 400);

  // nothing above should have created a booking
  const slots = await (await call('GET', '/slots')).json();
  assert.ok(slots.slots.every((s) => s.available));
});

test('level 2: name and email are trimmed and email lower-cased', async () => {
  await reset();
  const email = uniqueEmail('Trim');
  const res = await call('POST', '/bookings', {
    body: { slot_id: ' s1 ', name: '  Ada Obi  ', email: `  ${email.toUpperCase()}  ` },
  });
  assert.equal(res.status, 201);
  const booking = await res.json();
  assert.equal(booking.name, 'Ada Obi');
  assert.equal(booking.email, email.toLowerCase());
});

// ---------------------------------------------------------------------------
// level 3

test('level 3: a slot cannot be double booked; cancel frees it', async () => {
  await reset();
  const first = await call('POST', '/bookings', {
    body: { slot_id: 's1', name: 'One', email: uniqueEmail('c1') },
  });
  assert.equal(first.status, 201);
  const booking = await first.json();

  const clash = await call('POST', '/bookings', {
    body: { slot_id: 's1', name: 'Two', email: uniqueEmail('c2') },
  });
  assert.equal(clash.status, 409);
  assert.equal(typeof (await clash.json()).error, 'string');

  // the slot now shows as taken
  const slots = await (await call('GET', '/slots')).json();
  assert.equal(slots.slots.find((s) => s.id === 's1').available, false);

  // cancelling frees the slot
  const cancelled = await call('DELETE', `/bookings/${booking.id}`);
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, 'cancelled');

  const slots2 = await (await call('GET', '/slots')).json();
  assert.equal(slots2.slots.find((s) => s.id === 's1').available, true);

  const rebook = await call('POST', '/bookings', {
    body: { slot_id: 's1', name: 'Two', email: uniqueEmail('c3') },
  });
  assert.equal(rebook.status, 201);

  // double cancel and unknown ids
  assert.equal((await call('DELETE', `/bookings/${booking.id}`)).status, 409);
  assert.equal((await call('DELETE', '/bookings/nope')).status, 404);

  // cancelled bookings remain visible to their owner
  const mine = await (await call('GET', `/bookings?email=${booking.email}`)).json();
  assert.equal(mine.bookings.length, 1);
  assert.equal(mine.bookings[0].status, 'cancelled');
});

test('level 3: simultaneous requests cannot both book the same slot', async () => {
  await reset();
  const attempts = Array.from({ length: 15 }, (_, i) =>
    call('POST', '/bookings', {
      body: { slot_id: 's2', name: `Racer ${i}`, email: uniqueEmail(`race${i}`) },
    })
  );
  const results = await Promise.all(attempts);
  const created = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 409);
  assert.equal(created.length, 1, 'exactly one winner');
  assert.equal(rejected.length, 14, 'everyone else gets 409');

  // and the database holds exactly one confirmed booking for the slot
  const winner = await created[0].json();
  const mine = await (await call('GET', `/bookings?email=${winner.email}`)).json();
  assert.equal(mine.bookings.length, 1);
});

// ---------------------------------------------------------------------------
// level 4

test('level 4: a retried request never creates a duplicate booking', async () => {
  await reset();
  const email = uniqueEmail('idem');
  const body = { slot_id: 's1', name: 'Ada Obi', email };
  const headers = { 'Idempotency-Key': 'key-' + Date.now() };

  const first = await call('POST', '/bookings', { body, headers });
  assert.equal(first.status, 201);
  const booking = await first.json();

  const retry = await call('POST', '/bookings', { body, headers });
  assert.equal(retry.status, 201);
  assert.deepEqual(await retry.json(), booking);

  const third = await call('POST', '/bookings', { body, headers });
  assert.equal(third.status, 201);
  assert.equal((await third.json()).id, booking.id);

  // exactly one booking exists
  const mine = await (await call('GET', `/bookings?email=${email}`)).json();
  assert.equal(mine.bookings.length, 1);

  // the same key with a different body is refused
  const different = await call('POST', '/bookings', {
    body: { ...body, slot_id: 's2' },
    headers,
  });
  assert.equal(different.status, 422);
  assert.equal(typeof (await different.json()).error, 'string');
});

test('level 4: concurrent retries of the same request book once', async () => {
  await reset();
  const email = uniqueEmail('idemc');
  const body = { slot_id: 's1', name: 'Ada Obi', email };
  const headers = { 'Idempotency-Key': 'key-c-' + Date.now() };

  const results = await Promise.all([
    call('POST', '/bookings', { body, headers }),
    call('POST', '/bookings', { body, headers }),
    call('POST', '/bookings', { body, headers }),
  ]);
  assert.ok(results.every((r) => r.status === 201));
  const ids = await Promise.all(results.map(async (r) => (await r.json()).id));
  assert.equal(new Set(ids).size, 1, 'all three answer with the same booking id');

  const mine = await (await call('GET', `/bookings?email=${email}`)).json();
  assert.equal(mine.bookings.length, 1);
});

test('level 4: pagination walks a person\'s bookings oldest first', async () => {
  const calendar = Array.from({ length: 6 }, (_, i) => ({
    id: `s${i + 1}`,
    provider: 'Dr Ade',
    start: future(10 + i, 9),
    end: future(10 + i, 10),
  }));
  await reset(calendar);
  const email = uniqueEmail('page');
  const other = uniqueEmail('pageother');
  const made = [];
  for (let i = 0; i < 5; i++) {
    const res = await call('POST', '/bookings', {
      body: { slot_id: `s${i + 1}`, name: `Person ${i}`, email },
    });
    assert.equal(res.status, 201);
    made.push(await res.json());
  }
  // one booking for someone else must not leak into the page
  const leak = await call('POST', '/bookings', {
    body: { slot_id: 's6', name: 'Other', email: other },
  });
  assert.equal(leak.status, 201);

  // walk with limit=2
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const p = `/bookings?email=${encodeURIComponent(email)}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await call('GET', p);
    assert.equal(res.status, 200);
    const page = await res.json();
    seen.push(...page.bookings.map((b) => b.id));
    cursor = page.next_cursor;
    pages += 1;
    assert.ok(pages < 10, 'pagination terminates');
  } while (cursor);

  assert.deepEqual(seen, made.map((b) => b.id), 'oldest first, no gaps or repeats');

  // case-insensitive email match
  const upper = await (await call('GET', `/bookings?email=${encodeURIComponent(email.toUpperCase())}&limit=50`)).json();
  assert.equal(upper.bookings.length, 5);
  assert.equal(upper.next_cursor, null);

  // limit bounds
  assert.equal((await call('GET', `/bookings?email=${email}&limit=0`)).status, 400);
  assert.equal((await call('GET', `/bookings?email=${email}&limit=51`)).status, 400);
  assert.equal((await call('GET', `/bookings?email=${email}&limit=abc`)).status, 400);
  assert.equal((await call('GET', `/bookings?email=${email}&limit=2.5`)).status, 400);
  assert.equal((await call('GET', `/bookings`)).status, 400, 'email is required');
  assert.equal((await call('GET', `/bookings?email=${email}&cursor=garbage!!`)).status, 400);

  // an unknown email gets an empty page
  const nobody = await (await call('GET', `/bookings?email=${uniqueEmail('nobody')}`)).json();
  assert.deepEqual(nobody.bookings, []);
  assert.equal(nobody.next_cursor, null);
});

// ---------------------------------------------------------------------------
// level 5

test('level 5: the 6th attempt in a minute is rate limited', async () => {
  await reset([
    ...slotSet(),
    { id: 's5', provider: 'Dr Chi', start: future(5, 9), end: future(5, 10) },
  ]);
  const spam = uniqueEmail('spam');

  // two failures count towards the limit as well
  for (let i = 0; i < 2; i++) {
    const res = await call('POST', '/bookings', {
      body: { slot_id: 'does-not-exist', name: 'Spam', email: spam },
    });
    assert.equal(res.status, 404);
  }
  // three successes bring the total to five attempts
  for (let i = 0; i < 3; i++) {
    const res = await call('POST', '/bookings', {
      body: { slot_id: `s${i + 1}`, name: 'Spam', email: spam },
    });
    assert.equal(res.status, 201);
  }

  // the 6th attempt is refused
  const blocked = await call('POST', '/bookings', {
    body: { slot_id: 's3', name: 'Spam', email: spam },
  });
  assert.equal(blocked.status, 429);
  const retryAfter = blocked.headers.get('Retry-After');
  assert.ok(retryAfter !== null, 'Retry-After header present');
  assert.ok(/^\d+$/.test(retryAfter), `whole seconds, got ${retryAfter}`);
  assert.ok(parseInt(retryAfter, 10) >= 1);
  assert.equal(typeof (await blocked.json()).error, 'string');

  // other emails are not affected
  const other = await call('POST', '/bookings', {
    body: { slot_id: 's5', name: 'Fine', email: uniqueEmail('fine') },
  });
  assert.equal(other.status, 201);

  // a lookup is not an attempt and still works
  assert.equal((await call('GET', `/bookings?email=${spam}`)).status, 200);
});

test('level 5: an idempotent replay answers the same even while rate limited', async () => {
  await reset();
  const email = uniqueEmail('idemr');
  const body = { slot_id: 's1', name: 'Ada Obi', email };
  const headers = { 'Idempotency-Key': 'key-r-' + Date.now() };

  const first = await call('POST', '/bookings', { body, headers });
  assert.equal(first.status, 201);
  const booking = await first.json();

  // exhaust the minute's attempts
  for (let i = 0; i < 4; i++) {
    await call('POST', '/bookings', { body: { slot_id: 's2', name: 'Fill', email } });
  }
  const blocked = await call('POST', '/bookings', { body: { slot_id: 's3', name: 'Fill', email } });
  assert.equal(blocked.status, 429);

  // the retry with the same key and body still gets the original booking back
  const retry = await call('POST', '/bookings', { body, headers });
  assert.equal(retry.status, 201);
  assert.equal((await retry.json()).id, booking.id);
});

// ---------------------------------------------------------------------------
// plumbing

test('OPTIONS preflight is answered without an API key', async () => {
  const res = await fetch(base + '/bookings', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.ok(res.headers.get('access-control-allow-headers').includes('X-API-Key'));
});

test('errors always use the {"error": "..."} shape', async () => {
  const res = await call('GET', '/no-such-route');
  assert.equal(res.status, 404);
  assert.deepEqual(Object.keys(await res.json()), ['error']);

  const bad = await call('POST', '/bookings', { body: '{not json', headers: { 'Content-Type': 'application/json' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(await bad.json()), ['error']);
});
