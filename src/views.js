const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TYPE_LABELS = { text: 'Open answer', rating: 'Rating 1–5', choice: 'Multiple choice' };

function layout(title, body, { admin = false } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body class="${admin ? 'admin' : 'public'}">
${admin ? adminNav() : ''}
<main>${body}</main>
</body>
</html>`;
}

function adminNav() {
  return `<nav class="topbar">
  <strong>Survey admin</strong>
  <a href="/admin">Dashboard</a>
  <a href="/admin/responses">Responses</a>
  <a href="/admin/questions">Questions</a>
  <a href="/admin/export.xlsx" class="btn small">Export to Excel</a>
  <form method="post" action="/admin/logout" class="inline"><button class="link">Log out</button></form>
</nav>`;
}

function flash(message, kind = 'error') {
  return message ? `<p class="flash ${kind}">${esc(message)}</p>` : '';
}

// ---- participant pages ------------------------------------------------

function questionPage(title, question, error) {
  let input;
  if (question.type === 'rating') {
    input = `<div class="rating">${[1, 2, 3, 4, 5]
      .map((n) => `<label><input type="radio" name="answer" value="${n}" required><span>${n}</span></label>`)
      .join('')}</div>
      <div class="rating-legend"><span>Very low</span><span>Very high</span></div>`;
  } else if (question.type === 'choice') {
    input = `<div class="choices">${question.options
      .map((o) => `<label><input type="radio" name="answer" value="${esc(o)}" required> ${esc(o)}</label>`)
      .join('')}</div>`;
  } else {
    input = `<textarea name="answer" rows="6" maxlength="5000" required placeholder="Type your answer…"></textarea>`;
  }
  return layout(
    title,
    `<div class="card">
  <p class="eyebrow">${esc(title)}</p>
  <h1>${esc(question.text)}</h1>
  ${flash(error)}
  <form method="post" action="/">
    ${input}
    <button type="submit" class="btn">Submit answer</button>
  </form>
  <p class="muted">This survey is anonymous. Your answer is stored without any information that identifies you. You can answer only once.</p>
</div>`
  );
}

function messagePage(title, heading, text) {
  return layout(title, `<div class="card center"><h1>${esc(heading)}</h1><p>${esc(text)}</p></div>`);
}

// ---- admin pages ------------------------------------------------------

function loginPage(error) {
  return layout(
    'Admin login',
    `<div class="card narrow">
  <h1>Admin login</h1>
  ${flash(error)}
  <form method="post" action="/admin/login">
    <label>Password <input type="password" name="password" autofocus required></label>
    <button class="btn">Log in</button>
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
      <td>${TYPE_LABELS[q.type]}</td>
      <td class="num">${q.assigned_count}</td>
      <td class="num">${q.response_count}</td>
    </tr>`
    )
    .join('');
  return layout(
    'Dashboard',
    `<h1>Dashboard</h1>
${flash(message, 'ok')}
<section class="stats">
  <div><span>${stats.responses}</span>Responses</div>
  <div><span>${stats.participants}</span>Participants</div>
  <div><span>${rate}%</span>Completion rate</div>
  <div><span>${stats.activeQuestions}/${stats.questions}</span>Active questions</div>
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

<section class="card">
  <h2>Answers per question</h2>
  <table>
    <thead><tr><th>#</th><th>Question</th><th>Type</th><th class="num">Assigned</th><th class="num">Answered</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>

<section class="card danger">
  <h2>Reset</h2>
  <p>Delete all responses and participant records so everybody can take the survey again. Questions are kept.</p>
  <form method="post" action="/admin/reset" onsubmit="return confirm('Delete ALL responses? This cannot be undone.')">
    <button class="btn danger">Delete all responses</button>
  </form>
</section>`,
    { admin: true }
  );
}

function responsesPage({ responses, questions, questionId }) {
  const options = questions
    .map((q) => `<option value="${q.id}" ${q.id === questionId ? 'selected' : ''}>#${q.id} ${esc(q.text)}</option>`)
    .join('');
  const rows = responses
    .map(
      (r) => `<tr>
      <td>${r.id}</td>
      <td>#${r.question_id} ${esc(r.question)}</td>
      <td class="answer">${esc(r.answer)}</td>
      <td class="nowrap">${esc(r.submitted_at)} UTC</td>
    </tr>`
    )
    .join('');
  return layout(
    'Responses',
    `<h1>Responses <small>(${responses.length})</small></h1>
<form method="get" action="/admin/responses" class="filter">
  <select name="question" onchange="this.form.submit()">
    <option value="">All questions</option>${options}
  </select>
  <noscript><button class="btn small">Filter</button></noscript>
  <a class="btn small" href="/admin/export.xlsx${questionId ? `?question=${questionId}` : ''}">Export ${questionId ? 'this question' : 'all'} to Excel</a>
</form>
<section class="card">
  ${
    responses.length
      ? `<table><thead><tr><th>#</th><th>Question</th><th>Answer</th><th>Submitted</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="muted">No responses yet.</p>'
  }
</section>`,
    { admin: true }
  );
}

function questionForm(q = { text: '', type: 'text', options: [] }, action, submitLabel) {
  const typeOptions = Object.entries(TYPE_LABELS)
    .map(([value, label]) => `<option value="${value}" ${q.type === value ? 'selected' : ''}>${label}</option>`)
    .join('');
  return `<form method="post" action="${action}" class="question-form">
    <label>Question <textarea name="text" rows="2" required>${esc(q.text)}</textarea></label>
    <label>Type <select name="type">${typeOptions}</select></label>
    <label>Options (multiple choice only, one per line) <textarea name="options" rows="4">${esc(q.options.join('\n'))}</textarea></label>
    <button class="btn">${submitLabel}</button>
  </form>`;
}

function questionsPage({ questions, error, message }) {
  const rows = questions
    .map(
      (q) => `<tr class="${q.active ? '' : 'inactive'}">
      <td>${q.id}</td>
      <td>${esc(q.text)}${q.type === 'choice' ? `<div class="muted">${esc(q.options.join(' · '))}</div>` : ''}</td>
      <td>${TYPE_LABELS[q.type]}</td>
      <td class="num">${q.response_count}</td>
      <td class="actions">
        <a class="btn small" href="/admin/questions/${q.id}/edit">Edit</a>
        <form method="post" action="/admin/questions/${q.id}/toggle" class="inline">
          <button class="btn small secondary">${q.active ? 'Deactivate' : 'Activate'}</button>
        </form>
        <form method="post" action="/admin/questions/${q.id}/delete" class="inline"
              onsubmit="return confirm('Delete this question and its ${q.response_count} response(s)?')">
          <button class="btn small danger">Delete</button>
        </form>
      </td>
    </tr>`
    )
    .join('');
  return layout(
    'Questions',
    `<h1>Questions <small>(${questions.length})</small></h1>
${flash(error)}${flash(message, 'ok')}
<p class="muted">Each new participant receives one random active question. Questions that have been handed out the fewest times are picked first, so answers spread evenly. Inactive questions are never assigned.</p>
<section class="card">
  <h2>Add a question</h2>
  ${questionForm(undefined, '/admin/questions', 'Add question')}
</section>
<section class="card">
  <h2>Bulk add</h2>
  <form method="post" action="/admin/questions/bulk" class="question-form">
    <label>One open-answer question per line <textarea name="lines" rows="5"></textarea></label>
    <button class="btn">Add all</button>
  </form>
</section>
<section class="card">
  <table>
    <thead><tr><th>#</th><th>Question</th><th>Type</th><th class="num">Answers</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`,
    { admin: true }
  );
}

function editQuestionPage(q, error) {
  return layout(
    'Edit question',
    `<h1>Edit question #${q.id}</h1>
${flash(error)}
<section class="card">
  ${questionForm(q, `/admin/questions/${q.id}`, 'Save')}
  <p><a href="/admin/questions">← Back to questions</a></p>
</section>`,
    { admin: true }
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
