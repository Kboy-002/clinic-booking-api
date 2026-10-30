'use strict';

const { createApp, API_KEY } = require('./app');
const { seedDemoIfEmpty } = require('./demo');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const seeded = seedDemoIfEmpty();
if (seeded > 0) console.log(`Empty calendar at boot: seeded ${seeded} demo slots`);

createApp().listen(PORT, HOST, () => {
  console.log(`Clinic booking API listening on port ${PORT}`);
  console.log(`API key: ${API_KEY}`);
});
