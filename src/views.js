const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout(title, body, { admin = null, script = null } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="/static/style.css">
</head>
<body class="${admin ? 'admin' : 'public'}">
${admin ? adminNav(admin) : ''}
<main>${body}</main>
${script ? `<script src="/static/${script}" defer></script>` : ''}
</body>
</html>`;
}

function adminNav(active) {
  const link = (key, href, label) =>
    `<a href="${href}"${key === active ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<header class="topbar">
  <span class="brand">Survey</span>
  <nav>
    ${link('dashboard', '/admin', 'Overview')}
    ${link('responses', '/admin/responses', 'Responses')}
    ${link('questions', '/admin/questions', 'Questions')}
  </nav>
  <div class="topbar-end">
    <a href="/admin/export.xlsx" class="btn small">Export .xlsx</a>
    <form method="post" action="/admin/logout" class="inline"><button class="btn small ghost">Log out</button></form>
  </div>
</header>`;
}

function flash(message, kind = 'error') {
  return message ? `<p class="flash ${kind}">${esc(message)}</p>` : '';
}

// ---- participant pages ------------------------------------------------

function questionPage(title, question, { error, draft = '', maxLength }) {
  return layout(
    title,
    `<div class="survey">
  <p class="eyebrow">${esc(title)}</p>
  <h1 id="question">${esc(question.text)}</h1>
  ${flash(error)}
  <form method="post" action="/" class="answer-form" data-draft-key="survey-draft-${question.id}">
    <div class="answer-box">
      <textarea name="answer" rows="7" maxlength="${maxLength}" required autofocus
                aria-labelledby="question" placeholder="Write your answer here…">${esc(draft)}</textarea>
      <div class="answer-meta">
        <span class="hint">Draft saved on this device</span>
        <span class="counter" aria-live="polite" data-max="${maxLength}"></span>
      </div>
    </div>
    <div class="submit-row">
      <button type="submit" class="btn large">Submit answer <span aria-hidden="true">→</span></button>
      <span class="shortcut">or press <kbd>Ctrl</kbd> + <kbd>Enter</kbd></span>
    </div>
  </form>
  <p class="note">Anonymous · one answer per person · you can't edit it after submitting</p>
</div>`,
    { script: 'survey.js' }
  );
}

const ICONS = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
};

function messagePage(title, heading, text, icon = 'info') {
  return layout(
    title,
    `<div class="survey center"${icon === 'check' ? ' data-survey-done' : ''}><div class="icon">${ICONS[icon]}</div><h1>${esc(heading)}</h1><p class="lead">${esc(text)}</p></div>`,
    { script: icon === 'check' ? 'survey.js' : null }
  );
}

// ---- admin pages ------------------------------------------------------

function loginPage(error) {
  return layout(
    'Admin login',
    `<div class="login">
  <span class="brand">Survey</span>
  <h1>Sign in to admin</h1>
  ${flash(error)}
  <form method="post" action="/admin/login">
    <label>Password <input type="password" name="password" autofocus required></label>
    <button class="btn block">Sign in</button>
  </form>
</div>`
  );
}

function dashboardPage({ stats, questions, open, title, message, shareUrl }) {
  const rate = stats.participants ? Math.round((stats.responses / stats.participants) * 100) : 0;
  const rows = questions
    .map(
      (q) => `<tr class="${q.active ? '' : 'inactive'}">
      <td>${q.id}</td>
      <td><a href="/admin/responses?question=${q.id}">${esc(q.text)}</a></td>
      <td class="num">${q.assigned_count}</td>
      <td class="num">${q.response_count}</td>
    </tr>`
    )
    .join('');
  return layout(
    'Dashboard',
    `<h1>Overview</h1>
${flash(message, 'ok')}
<section class="stats">
  <div><span>${stats.responses}</span>Responses</div>
  <div><span>${stats.participants}</span>Participants</div>
  <div><span>${rate}%</span>Completion rate</div>
  <div><span>${stats.activeQuestions}<small>/${stats.questions}</small></span>Active questions</div>
</section>

<section class="card">
  <h2>Survey settings</h2>
  <form method="post" action="/admin/settings" class="settings">
    <label>Survey title <input name="title" value="${esc(title)}" maxlength="200"></label>
    <label class="check"><input type="checkbox" name="open" value="1" ${open ? 'checked' : ''}> Survey is open for new answers</label>
    <button class="btn">Save settings</button>
  </form>
  <p class="muted">Share this link with participants: <a href="${esc(shareUrl)}" target="_blank"><code>${esc(shareUrl)}</code></a></p>
</section>

<section class="card flush">
  <h2>Answers per question</h2>
  <table>
    <thead><tr><th>#</th><th>Question</th><th class="num">Assigned</th><th class="num">Answered</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>

<details class="card danger-zone">
  <summary>Danger zone</summary>
  <p class="muted">Delete all responses and participant records so everybody can take the survey again. Questions are kept.</p>
  <form method="post" action="/admin/reset" onsubmit="return confirm('Delete ALL responses? This cannot be undone.')">
    <button class="btn danger">Delete all responses</button>
  </form>
</details>`,
    { admin: 'dashboard' }
  );
}

const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;

function responsesPage({ responses, questions, questionId, search }) {
  const options = questions
    .map((q) => `<option value="${q.id}" ${q.id === questionId ? 'selected' : ''}>#${q.id} ${esc(q.text)}</option>`)
    .join('');
  const current = questions.find((q) => q.id === questionId);
  const query = new URLSearchParams({ ...(questionId && { question: questionId }), ...(search && { q: search }) }).toString();
  const filtered = Boolean(questionId || search);
  const items = responses
    .map(
      (r) => `<article class="response">
      <header>
        ${current ? '' : `<a href="/admin/responses?question=${r.question_id}" class="response-question"><span class="muted">#${r.question_id}</span> ${esc(r.question)}</a>`}
        <span class="response-meta">${wordCount(r.answer)} words · ${esc(r.submitted_at.slice(0, 16))} UTC · #${r.id}</span>
      </header>
      <p class="answer">${esc(r.answer)}</p>
    </article>`
    )
    .join('');
  return layout(
    'Responses',
    `<h1>Responses <small>(${responses.length})</small></h1>
<form method="get" action="/admin/responses" class="filter">
  <select name="question" onchange="this.form.submit()" aria-label="Question">
    <option value="">All questions</option>${options}
  </select>
  <input type="search" name="q" value="${esc(search)}" placeholder="Search in answers…" aria-label="Search in answers">
  <button class="btn small secondary">Search</button>
  ${filtered ? '<a class="btn small ghost" href="/admin/responses">Clear</a>' : ''}
  <a class="btn small secondary export" href="/admin/export.xlsx${query ? `?${query}` : ''}">Export ${filtered ? 'these' : 'all'} to Excel</a>
</form>
${current ? `<p class="lead">${esc(current.text)}</p>` : ''}
${items ? `<div class="responses">${items}</div>` : `<section class="card"><p class="empty">${filtered ? 'No answers match.' : 'No responses yet.'}</p></section>`}`,
    { admin: 'responses' }
  );
}

function questionForm(q = { text: '' }, action, submitLabel) {
  return `<form method="post" action="${action}" class="question-form">
    <label>Question <textarea name="text" rows="3" maxlength="1000" required placeholder="e.g. What would make your daily work easier?">${esc(q.text)}</textarea></label>
    <button class="btn">${submitLabel}</button>
  </form>`;
}

function questionsPage({ questions, error, message }) {
  const rows = questions
    .map(
      (q) => `<tr class="${q.active ? '' : 'inactive'}">
      <td>${q.id}</td>
      <td>${esc(q.text)}${q.active ? '' : ' <span class="tag off">Inactive</span>'}</td>
      <td class="num">${q.response_count}</td>
      <td class="actions">
        <a class="btn small ghost" href="/admin/questions/${q.id}/edit">Edit</a>
        <form method="post" action="/admin/questions/${q.id}/toggle" class="inline">
          <button class="btn small ghost">${q.active ? 'Deactivate' : 'Activate'}</button>
        </form>
        <form method="post" action="/admin/questions/${q.id}/delete" class="inline"
              onsubmit="return confirm('Delete this question and its ${q.response_count} response(s)?')">
          <button class="btn small ghost danger-text">Delete</button>
        </form>
      </td>
    </tr>`
    )
    .join('');
  return layout(
    'Questions',
    `<h1>Questions <small>(${questions.length})</small></h1>
${flash(error)}${flash(message, 'ok')}
<p class="lead muted">Each new participant receives one random active question. The least-assigned questions are picked first, so answers spread evenly. Inactive questions are never assigned.</p>
<div class="split">
  <details class="card"${error ? ' open' : ''}>
    <summary>Add a question</summary>
    ${questionForm(undefined, '/admin/questions', 'Add question')}
  </details>
  <details class="card">
    <summary>Bulk add</summary>
    <form method="post" action="/admin/questions/bulk" class="question-form">
      <label>One question per line <textarea name="lines" rows="5"></textarea></label>
      <button class="btn">Add all</button>
    </form>
  </details>
</div>
<section class="card flush">
  <table>
    <thead><tr><th>#</th><th>Question</th><th class="num">Answers</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`,
    { admin: 'questions' }
  );
}

function editQuestionPage(q, error) {
  return layout(
    'Edit question',
    `<p><a class="back" href="/admin/questions">← Questions</a></p>
<h1>Edit question <span class="muted">#${q.id}</span></h1>
${flash(error)}
<section class="card narrow-form">
  ${questionForm(q, `/admin/questions/${q.id}`, 'Save changes')}
</section>`,
    { admin: 'questions' }
  );
}

module.exports = {
  questionPage,
  messagePage,
  loginPage,
  dashboardPage,
  responsesPage,
  questionsPage,
  editQuestionPage,
};
