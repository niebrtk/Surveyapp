const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const QUESTION_TYPES = ['text', 'rating', 'choice'];

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS questions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT NOT NULL,
      type       TEXT NOT NULL DEFAULT 'text',
      options    TEXT NOT NULL DEFAULT '[]',
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One row per participant. Only a SHA-256 hash of the random browser
    -- token is kept, so the row cannot be traced back to a person.
    CREATE TABLE IF NOT EXISTS assignments (
      token_hash  TEXT PRIMARY KEY,
      -- SET NULL keeps the "already answered" record if a question is deleted.
      question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
      completed   INTEGER NOT NULL DEFAULT 0,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Answers are deliberately NOT linked to an assignment/token.
    CREATE TABLE IF NOT EXISTS responses (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id  INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      answer       TEXT NOT NULL,
      submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseQuestion(row) {
  if (!row) return row;
  return { ...row, options: JSON.parse(row.options), active: !!row.active };
}

class SurveyStore {
  constructor(file) {
    this.db = openDatabase(file);
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- settings ---------------------------------------------------------

  getSetting(key, fallback) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }

  setSetting(key, value) {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  isOpen() {
    return this.getSetting('survey_open', '1') === '1';
  }

  // ---- questions --------------------------------------------------------

  seedIfEmpty(seedFile) {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM questions').get();
    if (n > 0) return 0;
    const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    this.transaction(() => seed.forEach((q) => this.addQuestion(q)));
    return seed.length;
  }

  addQuestion({ text, type = 'text', options = [] }) {
    const clean = validateQuestion({ text, type, options });
    const info = this.db
      .prepare('INSERT INTO questions (text, type, options) VALUES (?, ?, ?)')
      .run(clean.text, clean.type, JSON.stringify(clean.options));
    return Number(info.lastInsertRowid);
  }

  updateQuestion(id, { text, type, options }) {
    const clean = validateQuestion({ text, type, options });
    this.db
      .prepare('UPDATE questions SET text = ?, type = ?, options = ? WHERE id = ?')
      .run(clean.text, clean.type, JSON.stringify(clean.options), id);
  }

  setQuestionActive(id, active) {
    this.db.prepare('UPDATE questions SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  }

  deleteQuestion(id) {
    this.db.prepare('DELETE FROM questions WHERE id = ?').run(id);
  }

  getQuestion(id) {
    return parseQuestion(this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id));
  }

  listQuestions() {
    return this.db
      .prepare(
        `SELECT q.*,
                (SELECT COUNT(*) FROM assignments a WHERE a.question_id = q.id) AS assigned_count,
                (SELECT COUNT(*) FROM responses r WHERE r.question_id = q.id)   AS response_count
           FROM questions q
          ORDER BY q.id`
      )
      .all()
      .map(parseQuestion);
  }

  // ---- participants -----------------------------------------------------

  getAssignment(token) {
    return this.db.prepare('SELECT * FROM assignments WHERE token_hash = ?').get(hashToken(token));
  }

  /**
   * Returns the participant's assignment, creating one if needed.
   * New participants get a random question among the active questions that
   * have been handed out the fewest times, so answers spread evenly across
   * all questions instead of clustering by chance.
   */
  getOrAssign(token) {
    return this.transaction(() => {
      const existing = this.getAssignment(token);
      if (existing && (existing.completed || existing.question_id !== null)) return existing;

      const candidates = this.db
        .prepare(
          `WITH counts AS (
             SELECT q.id, COUNT(a.token_hash) AS n
               FROM questions q
               LEFT JOIN assignments a ON a.question_id = q.id
              WHERE q.active = 1
              GROUP BY q.id
           )
           SELECT id FROM counts WHERE n = (SELECT MIN(n) FROM counts)`
        )
        .all();
      if (candidates.length === 0) return null;

      const pick = candidates[crypto.randomInt(candidates.length)].id;
      this.db
        .prepare(
          `INSERT INTO assignments (token_hash, question_id) VALUES (?, ?)
           ON CONFLICT(token_hash) DO UPDATE SET question_id = excluded.question_id, assigned_at = datetime('now')`
        )
        .run(hashToken(token), pick);
      return this.getAssignment(token);
    });
  }

  /** Stores the answer once. Returns false if this participant already answered. */
  submitAnswer(token, answer) {
    return this.transaction(() => {
      const assignment = this.getAssignment(token);
      if (!assignment || assignment.completed || assignment.question_id === null) return false;
      this.db.prepare('UPDATE assignments SET completed = 1 WHERE token_hash = ?').run(assignment.token_hash);
      this.db.prepare('INSERT INTO responses (question_id, answer) VALUES (?, ?)').run(assignment.question_id, answer);
      return true;
    });
  }

  // ---- reporting --------------------------------------------------------

  listResponses({ questionId } = {}) {
    const where = questionId ? 'WHERE r.question_id = ?' : '';
    const params = questionId ? [questionId] : [];
    return this.db
      .prepare(
        `SELECT r.id, r.question_id, q.text AS question, q.type, r.answer, r.submitted_at
           FROM responses r
           JOIN questions q ON q.id = r.question_id
           ${where}
          ORDER BY r.id DESC`
      )
      .all(...params);
  }

  stats() {
    const one = (sql) => Object.values(this.db.prepare(sql).get())[0];
    return {
      questions: one('SELECT COUNT(*) FROM questions'),
      activeQuestions: one('SELECT COUNT(*) FROM questions WHERE active = 1'),
      participants: one('SELECT COUNT(*) FROM assignments'),
      responses: one('SELECT COUNT(*) FROM responses'),
    };
  }

  deleteAllResponses() {
    this.transaction(() => {
      this.db.exec('DELETE FROM responses');
      this.db.exec('DELETE FROM assignments');
    });
  }
}

function validateQuestion({ text, type, options }) {
  text = String(text || '').trim();
  if (!text) throw new ValidationError('Question text is required.');
  if (!QUESTION_TYPES.includes(type)) throw new ValidationError('Unknown question type.');
  if (typeof options === 'string') options = options.split(/\r?\n/);
  options = (options || []).map((o) => String(o).trim()).filter(Boolean);
  if (type === 'choice' && options.length < 2) {
    throw new ValidationError('A multiple choice question needs at least two options.');
  }
  if (type !== 'choice') options = [];
  return { text, type, options };
}

class ValidationError extends Error {}

module.exports = { SurveyStore, ValidationError, QUESTION_TYPES, hashToken };
