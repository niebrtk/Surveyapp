const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const ExcelJS = require('exceljs');
const { ValidationError } = require('./db');
const views = require('./views');

const PARTICIPANT_COOKIE = 'survey_pid';
const ADMIN_COOKIE = 'survey_admin';
const ADMIN_SESSION_HOURS = 12;
const MAX_ANSWER_LENGTH = 5000;

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    try {
      cookies[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // ignore malformed cookie values
    }
  }
  return cookies;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function originHost(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function createApp({ store, adminPassword, secureCookies = false }) {
  if (!adminPassword) throw new Error('ADMIN_PASSWORD must be set');

  // Secret used to sign admin sessions; persisted so logins survive restarts.
  let secret = store.getSetting('session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    store.setSetting('session_secret', secret);
  }
  const sign = (value) => crypto.createHmac('sha256', secret).update(value).digest('base64url');

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use('/static', express.static(path.join(__dirname, '..', 'public')));
  app.use((req, res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  const surveyTitle = () => store.getSetting('title', 'Anonymous survey');

  // ---- participant --------------------------------------------------------

  function participantToken(req, res) {
    let token = req.cookies[PARTICIPANT_COOKIE];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      token = crypto.randomBytes(32).toString('base64url');
      res.cookie(PARTICIPANT_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookies,
        maxAge: 1000 * 60 * 60 * 24 * 365 * 5,
      });
    }
    return token;
  }

  function renderParticipant(req, res, error) {
    const title = surveyTitle();
    const token = participantToken(req, res);
    res.set('Cache-Control', 'no-store');

    const existing = store.getAssignment(token);
    if (existing?.completed) {
      return res.send(views.messagePage(title, 'Thank you!', 'You have already completed this survey. Your answer has been saved anonymously.'));
    }
    if (!existing && !store.isOpen()) {
      return res.send(views.messagePage(title, 'Survey closed', 'This survey is not accepting new answers at the moment.'));
    }
    const assignment = existing?.question_id ? existing : store.getOrAssign(token);
    const question = assignment && store.getQuestion(assignment.question_id);
    if (!question) {
      return res.send(views.messagePage(title, 'No questions yet', 'The survey has no questions yet. Please come back later.'));
    }
    res.status(error ? 400 : 200).send(views.questionPage(title, question, error));
  }

  app.get('/', (req, res) => renderParticipant(req, res));

  app.post('/', (req, res) => {
    const title = surveyTitle();
    const token = req.cookies[PARTICIPANT_COOKIE];
    const assignment = token && store.getAssignment(token);
    if (!assignment || assignment.completed || !assignment.question_id) return res.redirect(303, '/');
    if (!store.isOpen()) {
      return res.send(views.messagePage(title, 'Survey closed', 'This survey is not accepting new answers at the moment.'));
    }

    const question = store.getQuestion(assignment.question_id);
    const answer = String(req.body.answer ?? '').trim();
    let error;
    if (!answer) error = 'Please provide an answer.';
    else if (answer.length > MAX_ANSWER_LENGTH) error = `Your answer is too long (max ${MAX_ANSWER_LENGTH} characters).`;
    else if (question.type === 'rating' && !['1', '2', '3', '4', '5'].includes(answer)) error = 'Please pick a value from 1 to 5.';
    else if (question.type === 'choice' && !question.options.includes(answer)) error = 'Please pick one of the options.';
    if (error) return renderParticipant(req, res, error);

    store.submitAnswer(token, answer);
    res.redirect(303, '/');
  });

  // ---- admin auth ---------------------------------------------------------

  function isAdmin(req) {
    const value = req.cookies[ADMIN_COOKIE];
    if (!value) return false;
    const [expires, signature] = value.split('.');
    if (!expires || !signature || !safeEqual(sign(`admin:${expires}`), signature)) return false;
    return Number(expires) > Date.now();
  }

  app.get('/admin/login', (req, res) => {
    if (isAdmin(req)) return res.redirect('/admin');
    res.send(views.loginPage());
  });

  let failedLogins = [];
  app.post('/admin/login', (req, res) => {
    // Simple global brute-force brake: max 10 failed attempts per minute.
    const now = Date.now();
    failedLogins = failedLogins.filter((t) => now - t < 60_000);
    if (failedLogins.length >= 10) {
      return res.status(429).send(views.loginPage('Too many attempts. Please wait a minute and try again.'));
    }
    if (!safeEqual(req.body.password ?? '', adminPassword)) {
      failedLogins.push(now);
      return res.status(401).send(views.loginPage('Wrong password.'));
    }
    const expires = String(now + ADMIN_SESSION_HOURS * 3600 * 1000);
    res.cookie(ADMIN_COOKIE, `${expires}.${sign(`admin:${expires}`)}`, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookies,
      path: '/admin',
      maxAge: ADMIN_SESSION_HOURS * 3600 * 1000,
    });
    res.redirect(303, '/admin');
  });

  const admin = express.Router();
  admin.use((req, res, next) => {
    if (!isAdmin(req)) return res.redirect('/admin/login');
    res.set('Cache-Control', 'no-store');
    // CSRF protection on top of the SameSite=Strict cookie.
    const origin = req.headers.origin;
    if (req.method === 'POST' && origin && originHost(origin) !== req.headers.host) {
      return res.status(403).send('Forbidden');
    }
    next();
  });

  admin.post('/logout', (req, res) => {
    res.clearCookie(ADMIN_COOKIE, { path: '/admin' });
    res.redirect(303, '/admin/login');
  });

  // ---- admin pages --------------------------------------------------------

  admin.get('/', (req, res) => {
    res.send(
      views.dashboardPage({
        stats: store.stats(),
        questions: store.listQuestions(),
        open: store.isOpen(),
        title: surveyTitle(),
        message: req.query.msg,
        shareUrl: `${req.protocol}://${req.get('host')}/`,
      })
    );
  });

  admin.post('/settings', (req, res) => {
    const title = String(req.body.title || '').trim().slice(0, 200);
    if (title) store.setSetting('title', title);
    store.setSetting('survey_open', req.body.open === '1' ? '1' : '0');
    res.redirect(303, '/admin?msg=Settings+saved');
  });

  admin.post('/reset', (req, res) => {
    store.deleteAllResponses();
    res.redirect(303, '/admin?msg=All+responses+deleted');
  });

  const questionIdParam = (req) => {
    const id = Number(req.query.question);
    return Number.isInteger(id) && id > 0 ? id : undefined;
  };

  admin.get('/responses', (req, res) => {
    const questionId = questionIdParam(req);
    res.send(views.responsesPage({ responses: store.listResponses({ questionId }), questions: store.listQuestions(), questionId }));
  });

  admin.get('/questions', (req, res) => {
    res.send(views.questionsPage({ questions: store.listQuestions(), message: req.query.msg }));
  });

  admin.post('/questions', (req, res) => {
    try {
      store.addQuestion(req.body);
      res.redirect(303, '/admin/questions?msg=Question+added');
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      res.status(400).send(views.questionsPage({ questions: store.listQuestions(), error: err.message }));
    }
  });

  admin.post('/questions/bulk', (req, res) => {
    const lines = String(req.body.lines || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    lines.forEach((text) => store.addQuestion({ text, type: 'text' }));
    res.redirect(303, `/admin/questions?msg=${encodeURIComponent(`${lines.length} question(s) added`)}`);
  });

  const loadQuestion = (req, res, next) => {
    req.question = store.getQuestion(Number(req.params.id));
    if (!req.question) return res.status(404).send('Question not found');
    next();
  };

  admin.get('/questions/:id/edit', loadQuestion, (req, res) => {
    res.send(views.editQuestionPage(req.question));
  });

  admin.post('/questions/:id', loadQuestion, (req, res) => {
    try {
      store.updateQuestion(req.question.id, req.body);
      res.redirect(303, '/admin/questions?msg=Question+saved');
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      res.status(400).send(views.editQuestionPage({ ...req.question, ...req.body, options: String(req.body.options || '').split(/\r?\n/) }, err.message));
    }
  });

  admin.post('/questions/:id/toggle', loadQuestion, (req, res) => {
    store.setQuestionActive(req.question.id, !req.question.active);
    res.redirect(303, '/admin/questions');
  });

  admin.post('/questions/:id/delete', loadQuestion, (req, res) => {
    store.deleteQuestion(req.question.id);
    res.redirect(303, '/admin/questions?msg=Question+deleted');
  });

  // ---- Excel export ---------------------------------------------------------

  admin.get('/export.xlsx', async (req, res) => {
    const questionId = questionIdParam(req);
    const workbook = await buildWorkbook(store, { questionId, title: surveyTitle() });
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="survey-responses-${stamp}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  });

  app.use('/admin', admin);
  return app;
}

async function buildWorkbook(store, { questionId, title }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = title;
  workbook.created = new Date();

  const header = (sheet) => {
    const row = sheet.getRow(1);
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B5BDB' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
  };

  // Excel treats cells starting with = + - @ as formulas; neutralise them.
  const safeText = (v) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

  const responses = store.listResponses({ questionId }).reverse();
  const sheet = workbook.addWorksheet('Responses');
  sheet.columns = [
    { header: 'Response ID', key: 'id', width: 12 },
    { header: 'Question ID', key: 'question_id', width: 12 },
    { header: 'Question', key: 'question', width: 60 },
    { header: 'Question type', key: 'type', width: 16 },
    { header: 'Answer', key: 'answer', width: 70 },
    { header: 'Submitted at (UTC)', key: 'submitted_at', width: 20 },
  ];
  for (const r of responses) {
    sheet.addRow({
      ...r,
      question: safeText(r.question),
      answer: r.type === 'rating' ? Number(r.answer) : safeText(r.answer),
      submitted_at: new Date(`${r.submitted_at.replace(' ', 'T')}Z`),
    });
  }
  sheet.getColumn('submitted_at').numFmt = 'yyyy-mm-dd hh:mm:ss';
  sheet.getColumn('question').alignment = { wrapText: true, vertical: 'top' };
  sheet.getColumn('answer').alignment = { wrapText: true, vertical: 'top' };
  header(sheet);

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [
    { header: 'Question ID', key: 'id', width: 12 },
    { header: 'Question', key: 'text', width: 60 },
    { header: 'Type', key: 'type', width: 16 },
    { header: 'Active', key: 'active', width: 8 },
    { header: 'Participants assigned', key: 'assigned_count', width: 22 },
    { header: 'Answers', key: 'response_count', width: 10 },
    { header: 'Average rating', key: 'avg', width: 15 },
  ];
  const byQuestion = new Map();
  for (const r of store.listResponses()) {
    if (!byQuestion.has(r.question_id)) byQuestion.set(r.question_id, []);
    byQuestion.get(r.question_id).push(r.answer);
  }
  for (const q of store.listQuestions()) {
    if (questionId && q.id !== questionId) continue;
    const answers = byQuestion.get(q.id) || [];
    const avg = q.type === 'rating' && answers.length ? answers.reduce((s, a) => s + Number(a), 0) / answers.length : null;
    summary.addRow({ ...q, text: safeText(q.text), active: q.active ? 'Yes' : 'No', avg: avg === null ? '' : Math.round(avg * 100) / 100 });
  }
  summary.getColumn('text').alignment = { wrapText: true, vertical: 'top' };
  header(summary);

  return workbook;
}

module.exports = { createApp, buildWorkbook };
