const path = require('node:path');
const { SurveyStore } = require('./db');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'survey.db');
const adminPassword = process.env.ADMIN_PASSWORD;

if (!adminPassword) {
  console.error('Please set the ADMIN_PASSWORD environment variable, e.g.\n  ADMIN_PASSWORD=choose-a-strong-one npm start');
  process.exit(1);
}

const store = new SurveyStore(dbFile);
const seeded = store.seedIfEmpty(path.join(__dirname, 'questions.seed.json'));
if (seeded) console.log(`Added ${seeded} sample questions.`);

const app = createApp({
  store,
  adminPassword,
  secureCookies: process.env.SECURE_COOKIES === '1',
});

app.listen(port, () => {
  console.log(`Survey:      http://localhost:${port}/`);
  console.log(`Admin panel: http://localhost:${port}/admin`);
});
