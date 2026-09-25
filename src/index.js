const path = require('node:path');
const { SurveyStore } = require('./db');
const { createApp } = require('./app');

// Azure App Service sets WEBSITE_SITE_NAME. There, only /home survives restarts
// and deployments, and it is a network share, so SQLite must not use WAL.
const onAzure = Boolean(process.env.WEBSITE_SITE_NAME);

const port = Number(process.env.PORT) || 3000;
const dbFile =
  process.env.DATABASE_FILE || (onAzure ? '/home/data/survey.db' : path.join(__dirname, '..', 'data', 'survey.db'));
const journalMode = process.env.SQLITE_JOURNAL_MODE || (onAzure ? 'DELETE' : 'WAL');
const secureCookies = process.env.SECURE_COOKIES ? process.env.SECURE_COOKIES === '1' : onAzure;
const adminPassword = process.env.ADMIN_PASSWORD;

if (!adminPassword) {
  console.error('Please set the ADMIN_PASSWORD environment variable, e.g.\n  ADMIN_PASSWORD=choose-a-strong-one npm start');
  process.exit(1);
}

const store = new SurveyStore(dbFile, { journalMode });
const seeded = store.seedIfEmpty(path.join(__dirname, 'questions.seed.json'));
if (seeded) console.log(`Added ${seeded} sample questions.`);
console.log(`Database: ${dbFile} (journal mode ${journalMode})`);

const app = createApp({ store, adminPassword, secureCookies });

// Express 5 passes startup errors (e.g. port already in use) to this callback.
const server = app.listen(port, (err) => {
  if (err) {
    console.error(`Could not start the server on port ${port}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Survey:      http://localhost:${port}/`);
  console.log(`Admin panel: http://localhost:${port}/admin`);
});

// Close the database cleanly when the platform stops or restarts the app.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
