'use strict';

const db = require('./db');

const PROVIDERS = ['Dr Ade', 'Dr Bola', 'Dr Chi'];

// Fills an empty calendar with demo slots so the web page is never bare.
// Runs only at boot when there are no slots at all; POST /reset always wins
// afterwards, so automated checks that seed their own slots are unaffected.
function seedDemoIfEmpty() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM slots').get();
  if (n > 0) return 0;

  const pad = (x) => String(x).padStart(2, '0');
  const dayMs = 24 * 60 * 60 * 1000;
  const slots = [];
  for (let d = 1; d <= 21 && slots.length < 12; d++) {
    const date = new Date(Date.now() + d * dayMs);
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const ymd = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    [9, 10, 11].forEach((h, i) => {
      if (slots.length >= 12) return;
      const start = `${ymd}T${pad(h)}:00:00Z`;
      slots.push({
        id: `s${slots.length + 1}`,
        provider: PROVIDERS[(d + i) % PROVIDERS.length],
        start_raw: start,
        end_raw: `${ymd}T${pad(h)}:30:00Z`,
        start_ms: Date.parse(start),
      });
    });
  }

  const insert = db.prepare(
    'INSERT INTO slots (id, provider, start_raw, end_raw, start_ms) VALUES (@id, @provider, @start_raw, @end_raw, @start_ms)'
  );
  db.transaction(() => {
    for (const s of slots) insert.run(s);
  })();
  return slots.length;
}

module.exports = { seedDemoIfEmpty };
