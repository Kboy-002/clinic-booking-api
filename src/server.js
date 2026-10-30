'use strict';

const { createApp, API_KEY } = require('./app');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

createApp().listen(PORT, HOST, () => {
  console.log(`Clinic booking API listening on port ${PORT}`);
  console.log(`API key: ${API_KEY}`);
});
