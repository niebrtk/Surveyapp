# Randomized anonymous survey

A small web app where **each participant gets one random question** from a pool
(50 sample questions are included), answers it **anonymously**, and **can only
answer once**. An **admin panel** shows all answers and exports them to **Excel**.

## Quick start

Requires Node.js **22.5 or newer**. It uses the built-in `node:sqlite`, so you don't need to install a database server.

```bash
npm install
ADMIN_PASSWORD='choose-a-strong-password' npm start
```

- Survey (share this link): http://localhost:3000/
- Admin panel: http://localhost:3000/admin

The first time the app starts, it loads the 50 sample questions from `src/questions.seed.json`.
To use your own questions, edit that file before the first start, or manage questions later in the admin panel.

### Configuration (environment variables)

| Variable         | Default          | Description                                                   |
| ---------------- | ---------------- | ------------------------------------------------------------- |
| `ADMIN_PASSWORD` | – (required)     | Password for the admin panel                                  |
| `PORT`           | `3000`           | HTTP port                                                     |
| `DATABASE_FILE`  | `data/survey.db` | SQLite file holding questions and answers                     |
| `SECURE_COOKIES` | off              | Set to `1` when served over HTTPS (recommended in production) |

## How it works

### Random question per participant
When someone opens the survey, they are assigned one of the **active** questions.
The app picks at random among the questions that have been handed out the fewest times so far.
With 50 questions and 100 participants, every question gets about 2 answers,
instead of some questions getting many answers and others none. Reloading the page shows the same
question, so participants can't "re-roll".

### Answer once
The browser gets a random, meaningless ID in a cookie. The server keeps only a
SHA‑256 hash of it, together with the assigned question and a "completed" flag.
After answering, that browser sees a "Thank you" page.

### Anonymous
- No login, name, e‑mail or IP address is collected or stored.
- Answers are stored in a separate table with **no link** to the participant
  ID. That table holds only the question, the answer and the time.

> **Limitation:** "fill once" is enforced per browser. Someone who clears cookies,
> uses a private window or switches to another device could answer again. To prevent
> that completely, you would have to identify people (for example with logins or one-time invite codes),
> and that conflicts with full anonymity.

### Admin panel (`/admin`)
- **Dashboard**: see the number of responses and participants, the completion rate and the answers per
  question; change the survey title; open or close the survey; delete all responses.
- **Responses**: all answers, filterable by question.
- **Questions**: add questions (open answer, 1–5 rating or multiple choice), add many at once,
  edit, activate or deactivate, delete.
- **Export to Excel**: an `.xlsx` file with a *Responses* sheet (one row per
  answer) and a *Summary* sheet (answers per question, average rating). You can
  export all questions or a single question.

## Tests

```bash
npm test
```

## Deploying

The app runs on any host with Node 22.5 or newer (a VPS, Render, Railway, Fly.io…). Make sure
`DATABASE_FILE` points to persistent storage, set `ADMIN_PASSWORD`, serve the app over
HTTPS and set `SECURE_COOKIES=1`. Back up the SQLite file to keep your data safe.
