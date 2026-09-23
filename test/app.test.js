const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { SurveyStore } = require('../src/db');
const { createApp } = require('../src/app');

const PASSWORD = 'secret-test-password';
let store, server, base;

beforeEach(async () => {
  store = new SurveyStore(':memory:');
  store.seedIfEmpty(path.join(__dirname, '..', 'src', 'questions.seed.json'));
  const app = createApp({ store, adminPassword: PASSWORD });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  server.close();
  store.close();
});

/** Minimal browser: keeps cookies between requests. */
function browser() {
  const jar = new Map();
  return async (url, { form, ...opts } = {}) => {
    const headers = { ...opts.headers };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(form).toString();
      opts.method = 'POST';
    }
    const res = await fetch(base + url, { redirect: 'manual', ...opts, headers });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  };
}

function answerFor(question) {
  if (question.type === 'rating') return '4';
  if (question.type === 'choice') return question.options[0];
  return 'My answer';
}

async function assignedQuestion(page) {
  const html = await page('/').then((r) => r.text());
  const text = html.match(/<h1>(.*?)<\/h1>/)[1];
  return store.listQuestions().find((q) => q.text.replace(/'/g, '&#39;') === text);
}

async function loggedInAdmin() {
  const admin = browser();
  const res = await admin('/admin/login', { form: { password: PASSWORD } });
  assert.strictEqual(res.status, 303);
  return admin;
}

test('seeds 50 questions', () => {
  assert.strictEqual(store.listQuestions().length, 50);
});

test('a participant keeps the same question and can answer only once', async () => {
  const page = browser();
  const q1 = await assignedQuestion(page);
  const q2 = await assignedQuestion(page);
  assert.ok(q1);
  assert.strictEqual(q1.id, q2.id, 'reloading must not change the question');

  const res = await page('/', { form: { answer: answerFor(q1) } });
  assert.strictEqual(res.status, 303);

  const after = await page('/').then((r) => r.text());
  assert.match(after, /completed this survey/);

  // A second submission is ignored.
  await page('/', { form: { answer: answerFor(q1) } });
  assert.strictEqual(store.stats().responses, 1);
});

test('answers are stored without any link to the participant', async () => {
  const page = browser();
  const q = await assignedQuestion(page);
  await page('/', { form: { answer: answerFor(q) } });
  const columns = store.db.prepare('PRAGMA table_info(responses)').all().map((c) => c.name);
  assert.deepStrictEqual(columns, ['id', 'question_id', 'answer', 'submitted_at']);
});

test('questions are distributed evenly across participants', async () => {
  for (let i = 0; i < 100; i++) await assignedQuestion(browser());
  const counts = store.listQuestions().map((q) => q.assigned_count);
  assert.ok(counts.every((n) => n === 2), `expected 2 each, got ${counts}`);
});

test('invalid answers are rejected', async () => {
  const page = browser();
  const q = await assignedQuestion(page);
  const res = await page('/', { form: { answer: q.type === 'text' ? '   ' : 'not-an-option' } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(store.stats().responses, 0);
});

test('closed survey does not accept new participants', async () => {
  store.setSetting('survey_open', '0');
  const html = await browser()('/').then((r) => r.text());
  assert.match(html, /Survey closed/);
  assert.strictEqual(store.stats().participants, 0);
});

test('deleting a question does not let finished participants answer again', async () => {
  const page = browser();
  const q = await assignedQuestion(page);
  await page('/', { form: { answer: answerFor(q) } });
  store.deleteQuestion(q.id);
  assert.match(await page('/').then((r) => r.text()), /completed this survey/);
});

test('admin pages require login', async () => {
  const anon = browser();
  for (const url of ['/admin', '/admin/responses', '/admin/questions', '/admin/export.xlsx']) {
    const res = await anon(url);
    assert.strictEqual(res.status, 302, url);
    assert.strictEqual(res.headers.get('location'), '/admin/login');
  }
  const bad = await anon('/admin/login', { form: { password: 'wrong' } });
  assert.strictEqual(bad.status, 401);
});

test('admin sees responses and can export them to Excel', async () => {
  const page = browser();
  const q = await assignedQuestion(page);
  await page('/', { form: { answer: q.type === 'text' ? '=HYPERLINK("x") <b>hi</b>' : answerFor(q) } });

  const admin = await loggedInAdmin();
  const list = await admin('/admin/responses').then((r) => r.text());
  assert.match(list, /Responses <small>\(1\)/);
  assert.doesNotMatch(list, /<b>hi<\/b>/, 'answers must be HTML-escaped');

  const res = await admin('/admin/export.xlsx');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const sheet = wb.getWorksheet('Responses');
  assert.strictEqual(sheet.rowCount, 2);
  assert.strictEqual(sheet.getRow(2).getCell(3).value, q.text);
  const answer = sheet.getRow(2).getCell(5).value;
  if (q.type === 'text') assert.ok(String(answer).startsWith("'="), 'formula injection must be neutralised');
  assert.strictEqual(wb.getWorksheet('Summary').rowCount, 51);
});

test('admin can add, edit, deactivate and delete questions', async () => {
  const admin = await loggedInAdmin();
  await admin('/admin/questions', { form: { text: 'Favourite colour?', type: 'choice', options: 'Red\nBlue' } });
  const added = store.listQuestions().at(-1);
  assert.deepStrictEqual([added.text, added.options], ['Favourite colour?', ['Red', 'Blue']]);

  await admin(`/admin/questions/${added.id}`, { form: { text: 'Favourite season?', type: 'text', options: '' } });
  assert.strictEqual(store.getQuestion(added.id).text, 'Favourite season?');

  await admin(`/admin/questions/${added.id}/toggle`, { form: {} });
  assert.strictEqual(store.getQuestion(added.id).active, false);

  await admin(`/admin/questions/${added.id}/delete`, { form: {} });
  assert.strictEqual(store.getQuestion(added.id), undefined);

  const invalid = await admin('/admin/questions', { form: { text: 'Pick', type: 'choice', options: 'Only one' } });
  assert.strictEqual(invalid.status, 400);
});

test('cross-site admin POSTs are rejected', async () => {
  const admin = await loggedInAdmin();
  const res = await admin('/admin/reset', { form: {}, headers: { origin: 'https://evil.example' } });
  assert.strictEqual(res.status, 403);
});
