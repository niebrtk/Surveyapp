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

async function assignedQuestion(page) {
  const html = await page('/').then((r) => r.text());
  const text = html.match(/<h1 id="question">(.*?)<\/h1>/)[1];
  return store.listQuestions().find((q) => q.text.replace(/'/g, '&#39;') === text);
}

async function loggedInAdmin() {
  const admin = browser();
  const res = await admin('/admin/login', { form: { password: PASSWORD } });
  assert.strictEqual(res.status, 303);
  return admin;
}

test('seeds 50 open questions', () => {
  const questions = store.listQuestions();
  assert.strictEqual(questions.length, 50);
  assert.deepStrictEqual(Object.keys(questions[0]).sort(), ['active', 'assigned_count', 'created_at', 'id', 'response_count', 'text']);
});

test('participants get a free-text answer box', async () => {
  const html = await browser()('/').then((r) => r.text());
  assert.match(html, /<textarea name="answer"[^>]*maxlength="5000"[^>]*required/);
  assert.doesNotMatch(html, /type="radio"/);
});

test('multi-line answers are stored with their line breaks', async () => {
  const page = browser();
  await assignedQuestion(page);
  await page('/', { form: { answer: '  First line\r\n\r\nSecond line  ' } });
  assert.strictEqual(store.listResponses()[0].answer, 'First line\n\nSecond line');
});

test('a participant keeps the same question and can answer only once', async () => {
  const page = browser();
  const q1 = await assignedQuestion(page);
  const q2 = await assignedQuestion(page);
  assert.ok(q1);
  assert.strictEqual(q1.id, q2.id, 'reloading must not change the question');

  const res = await page('/', { form: { answer: 'My answer' } });
  assert.strictEqual(res.status, 303);

  const after = await page('/').then((r) => r.text());
  assert.match(after, /completed this survey/);

  // A second submission is ignored.
  await page('/', { form: { answer: 'My answer' } });
  assert.strictEqual(store.stats().responses, 1);
});

test('answers are stored without any link to the participant', async () => {
  const page = browser();
  const q = await assignedQuestion(page);
  await page('/', { form: { answer: 'My answer' } });
  const columns = store.db.prepare('PRAGMA table_info(responses)').all().map((c) => c.name);
  assert.deepStrictEqual(columns, ['id', 'question_id', 'answer', 'submitted_at']);
});

test('questions are distributed evenly across participants', async () => {
  for (let i = 0; i < 100; i++) await assignedQuestion(browser());
  const counts = store.listQuestions().map((q) => q.assigned_count);
  assert.ok(counts.every((n) => n === 2), `expected 2 each, got ${counts}`);
});

test('empty and too long answers are rejected, keeping the typed text', async () => {
  const page = browser();
  await assignedQuestion(page);
  const empty = await page('/', { form: { answer: '   ' } });
  assert.strictEqual(empty.status, 400);

  const long = 'x'.repeat(5001);
  const tooLong = await page('/', { form: { answer: long } });
  assert.strictEqual(tooLong.status, 400);
  assert.ok((await tooLong.text()).includes(long), 'typed text must be kept');
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
  await page('/', { form: { answer: 'My answer' } });
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
  await page('/', { form: { answer: '=HYPERLINK("x") <b>hi</b>' } });

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
  assert.ok(String(sheet.getRow(2).getCell(4).value).startsWith("'="), 'formula injection must be neutralised');
  assert.strictEqual(sheet.getRow(2).getCell(5).value, 2, 'word count');
  const grid = wb.getWorksheet('By question');
  assert.strictEqual(grid.getRow(1).getCell(1).value, `#${q.id} ${q.text}`);
  assert.strictEqual(wb.getWorksheet('Summary').rowCount, 51);
});

test('admin can search answers', async () => {
  for (const answer of ['More coffee, please', 'Better tools', '100% remote']) {
    const page = browser();
    await assignedQuestion(page);
    await page('/', { form: { answer } });
  }
  const admin = await loggedInAdmin();
  const html = await admin('/admin/responses?q=coffee').then((r) => r.text());
  assert.match(html, /Responses <small>\(1\)/);
  assert.strictEqual(store.listResponses({ search: '%' }).length, 1, 'LIKE wildcards are matched literally');
});

test('admin can add, edit, deactivate and delete questions', async () => {
  const admin = await loggedInAdmin();
  await admin('/admin/questions', { form: { text: 'What is your favourite colour?' } });
  const added = store.listQuestions().at(-1);
  assert.strictEqual(added.text, 'What is your favourite colour?');

  await admin('/admin/questions/bulk', { form: { lines: 'First?\n\nSecond?' } });
  assert.strictEqual(store.listQuestions().length, 53);

  await admin(`/admin/questions/${added.id}`, { form: { text: 'Favourite season?' } });
  assert.strictEqual(store.getQuestion(added.id).text, 'Favourite season?');

  await admin(`/admin/questions/${added.id}/toggle`, { form: {} });
  assert.strictEqual(store.getQuestion(added.id).active, false);

  await admin(`/admin/questions/${added.id}/delete`, { form: {} });
  assert.strictEqual(store.getQuestion(added.id), undefined);

  const invalid = await admin('/admin/questions', { form: { text: '   ' } });
  assert.strictEqual(invalid.status, 400);
});

test('cross-site admin POSTs are rejected', async () => {
  const admin = await loggedInAdmin();
  const res = await admin('/admin/reset', { form: {}, headers: { origin: 'https://evil.example' } });
  assert.strictEqual(res.status, 403);
});
