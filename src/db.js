const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const MAX_QUESTION_LENGTH = 1000;

const JOURNAL_MODES = ['WAL', 'DELETE', 'TRUNCATE', 'PERSIST'];

// WAL is fastest, but it needs shared memory and does not work reliably on
// network drives (e.g. the /home share on Azure App Service). Use DELETE there.
function openDatabase(file, { journalMode = 'WAL' } = {}) {
  journalMode = String(journalMode).toUpperCase();
  if (!JOURNAL_MODES.includes(journalMode)) throw new Error(`Unsupported SQLite journal mode: ${journalMode}`);
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = ${journalMode};
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS questions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT NOT NULL,
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
  return { id: row.id, text: row.text, active: !!row.active, created_at: row.created_at, assigned_count: row.assigned_count, response_count: row.response_count };
}

class SurveyStore {
  constructor(file, options) {
    this.db = openDatabase(file, options);
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
    this.transaction(() => seed.forEach((text) => this.addQuestion(text)));
    return seed.length;
  }

  addQuestion(text) {
    const info = this.db.prepare('INSERT INTO questions (text) VALUES (?)').run(validateQuestion(text));
    return Number(info.lastInsertRowid);
  }

  updateQuestion(id, text) {
    this.db.prepare('UPDATE questions SET text = ? WHERE id = ?').run(validateQuestion(text), id);
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

  /** Responses, newest first, optionally filtered by question and/or a text search in the answer. */
  listResponses({ questionId, search } = {}) {
    const where = [];
    const params = [];
    if (questionId) {
      where.push('r.question_id = ?');
      params.push(questionId);
    }
    if (search) {
      where.push("r.answer LIKE ? ESCAPE '\\'");
      params.push(`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    return this.db
      .prepare(
        `SELECT r.id, r.question_id, q.text AS question, r.answer, r.submitted_at
           FROM responses r
           JOIN questions q ON q.id = r.question_id
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
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

function validateQuestion(text) {
  text = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!text) throw new ValidationError('Question text is required.');
  if (text.length > MAX_QUESTION_LENGTH) throw new ValidationError(`Question is too long (max ${MAX_QUESTION_LENGTH} characters).`);
  return text;
}

class ValidationError extends Error {}

module.exports = { SurveyStore, ValidationError, hashToken };
