// Minimal local API server for the Task App: resolves a participant's assigned GenericTask via
// their magic link and accepts their file-upload submission, against the shared Neon Postgres
// database. Run with `node --env-file=.env server.mjs` (Neon) or `--env-file=.env.local` (local
// dev Postgres, DB_MODE=local). Mirrors the pattern used by REI-40/Big Five's own server.mjs.

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { neon } from '@neondatabase/serverless';
import { createLocalSql } from './server/local-db.mjs';

const PORT = process.env.PORT || 4314;

// Fixed checkbox categories a researcher can restrict uploads to — must match
// admin-dashboard-andrejkatin/server/generic-tasks/routes.mjs's FILE_TYPE_CATEGORIES /
// FILE_TYPE_EXTENSIONS exactly (duplicated here per this project's established per-app
// duplication convention for small shared config — no package shared between these repos).
const FILE_TYPE_EXTENSIONS = {
  PDF: ['.pdf'],
  WORD: ['.doc', '.docx'],
  EXCEL: ['.xls', '.xlsx', '.csv'],
  POWERPOINT: ['.ppt', '.pptx'],
  ZIP: ['.zip', '.rar', '.7z'],
  IMAGE: ['.jpg', '.jpeg', '.png', '.gif'],
  TEXT: ['.txt', '.md'],
};

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 20;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES } });

// Dual-mode (DB_MODE=local for local dev Postgres, else Neon) — same convention as every other
// app in this ecosystem.
let dbClient;
function getDb() {
  if (!dbClient) {
    if (process.env.DB_MODE === 'local') {
      const url = process.env.LOCAL_DATABASE_URL;
      if (!url) throw new Error('LOCAL_DATABASE_URL environment variable is not set (DB_MODE=local)');
      dbClient = createLocalSql(url);
      console.log('[db] developer mode: local Postgres');
    } else {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL environment variable is not set');
      dbClient = neon(url);
    }
  }
  return dbClient;
}

function isNonEmptyString(v, max) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function extensionOf(filename) {
  const i = filename.lastIndexOf('.');
  return i === -1 ? '' : filename.slice(i).toLowerCase();
}

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());

// Resolves a GENERIC_TASK magic-link token to the participant's currently-assigned task — live,
// not baked into the token (a researcher reassigning the task in admin takes effect on the same
// link immediately, same as REI-40's Rei40Variant resolution). Joins on ParticipantGuid, not the
// bare ParticipantId string — this project's own established per-research-scoping rule (item 1 of
// admin-dashboard's "platform improvements round 2" plan).
async function resolveTaskLink(sql, token) {
  const rows = await sql`
    SELECT sat."ParticipantId", sat."ParticipantGuid", sat."ExpiresAt", p."Language",
           r."ConsentPortalActive", p."GenericTaskId",
           t."Title", t."InstructionsText", t."PdfFilename", t."TimerMinutes", t."AllowedFileTypes", t."AllowMultipleFiles"
    FROM "SurveyAccessToken" sat
    JOIN "Participant" p ON p."Guid" = sat."ParticipantGuid"
    JOIN "Research" r ON r."Id" = p."ResearchId"
    LEFT JOIN "GenericTask" t ON t."Id" = p."GenericTaskId"
    WHERE sat."Token" = ${token} AND sat."SurveyType" = 'GENERIC_TASK'
    LIMIT 1
  `;
  if (!rows.length) return { error: 'NOT_FOUND' };
  const row = rows[0];
  if (new Date(row.ExpiresAt) < new Date()) return { error: 'EXPIRED' };
  if (row.ConsentPortalActive === false) return { error: 'NOT_ACTIVE' };
  if (row.GenericTaskId == null || !row.Title) {
    // The participant's task assignment was removed after the link was issued — treat the same
    // as "not found" rather than crashing on a null task.
    return { error: 'NOT_FOUND' };
  }
  const existing = await sql`SELECT 1 FROM "GenericTaskSubmission" WHERE "ParticipantGuid" = ${row.ParticipantGuid} LIMIT 1`;
  if (existing.length) return { error: 'ALREADY_COMPLETED' };
  return { row };
}

app.get('/api/link/:token', async (req, res) => {
  const token = req.params.token;
  if (!isNonEmptyString(token, 64)) {
    res.status(400).json({ error: 'Invalid token' });
    return;
  }
  try {
    const sql = getDb();
    const result = await resolveTaskLink(sql, token);
    if (result.error) {
      const status = result.error === 'EXPIRED' ? 410 : result.error === 'NOT_ACTIVE' ? 403 : result.error === 'ALREADY_COMPLETED' ? 409 : 404;
      res.status(status).json({ error: result.error });
      return;
    }
    const row = result.row;
    res.json({
      participantId: row.ParticipantId,
      lang: row.Language ?? 'sr',
      taskTitle: row.Title,
      taskInstructionsText: row.InstructionsText,
      hasPdf: !!row.PdfFilename,
      timerMinutes: row.TimerMinutes,
      allowedFileTypes: row.AllowedFileTypes ?? [],
      allowMultipleFiles: row.AllowMultipleFiles === true,
    });
  } catch (err) {
    console.error('[DB] link resolve error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.get('/api/task/pdf/:token', async (req, res) => {
  const token = req.params.token;
  if (!isNonEmptyString(token, 64)) {
    res.status(400).json({ error: 'Invalid token' });
    return;
  }
  try {
    const sql = getDb();
    // Re-validated the same way GET /api/link/:token is — a token must currently resolve (not
    // expired, not already-completed, research still active) before its PDF is servable. Fetches
    // the PDF bytes separately (not part of resolveTaskLink's own SELECT) so the common resolve
    // path never pulls a potentially-large BYTEA column when only metadata is needed.
    const result = await resolveTaskLink(sql, token);
    if (result.error) {
      res.status(404).json({ error: result.error });
      return;
    }
    const rows = await sql`SELECT "PdfFilename", "PdfContentType", "PdfContent" FROM "GenericTask" WHERE "Id" = ${result.row.GenericTaskId} LIMIT 1`;
    if (!rows.length || !rows[0].PdfContent) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    const r = rows[0];
    res.setHeader('Content-Type', r.PdfContentType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${r.PdfFilename}"`);
    res.send(Buffer.from(r.PdfContent));
  } catch (err) {
    console.error('[DB] pdf download error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

function uploadFiles(req, res, next) {
  upload.array('files', MAX_FILES)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `File too large (max ${MAX_FILE_BYTES / (1024 * 1024)}MB per file)` });
        return;
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        res.status(400).json({ error: `Too many files (max ${MAX_FILES})` });
        return;
      }
      console.error('[task-app] upload middleware error:', err);
      res.status(400).json({ error: 'Invalid upload' });
      return;
    }
    next();
  });
}

app.post('/api/link/:token/submit', uploadFiles, async (req, res) => {
  const token = req.params.token;
  if (!isNonEmptyString(token, 64)) {
    res.status(400).json({ error: 'Invalid token' });
    return;
  }
  const isTimedOut = req.body?.isTimedOut === 'true' || req.body?.isTimedOut === true;
  const files = req.files ?? [];

  // A manual (non-timed-out) submit needs at least one file — the frontend already enforces this
  // via its Submit button's disabled state, but this is the authoritative check. A timed-out
  // auto-submit may legitimately have zero files (the participant ran out of time with nothing
  // ready) — never fabricated, just honestly recorded.
  if (!isTimedOut && files.length === 0) {
    res.status(400).json({ error: 'NO_FILES' });
    return;
  }

  try {
    const sql = getDb();
    const result = await resolveTaskLink(sql, token);
    if (result.error) {
      const status = result.error === 'EXPIRED' ? 410 : result.error === 'NOT_ACTIVE' ? 403 : result.error === 'ALREADY_COMPLETED' ? 409 : 404;
      res.status(status).json({ error: result.error });
      return;
    }
    const row = result.row;

    if (!row.AllowMultipleFiles && files.length > 1) {
      res.status(400).json({ error: 'SINGLE_FILE_ONLY' });
      return;
    }
    const allowedCats = row.AllowedFileTypes ?? [];
    if (allowedCats.length) {
      const allowedExts = allowedCats.flatMap((c) => FILE_TYPE_EXTENSIONS[c] ?? []);
      const badFile = files.find((f) => !allowedExts.includes(extensionOf(f.originalname)));
      if (badFile) {
        res.status(400).json({ error: 'INVALID_FILE_TYPE', filename: badFile.originalname });
        return;
      }
    }

    // One INSERT ... RETURNING for the submission row, then one INSERT per file — same
    // sequential-queries convention every other route in this ecosystem uses (no explicit
    // transaction; the neon serverless HTTP driver doesn't support one across separate queries).
    // ParticipantGuid is resolved by the shared set_participant_guid trigger from the plain
    // ParticipantId, same as every other participant-keyed insert across this project.
    const subRows = await sql`
      INSERT INTO "GenericTaskSubmission" ("ParticipantGuid", "GenericTaskId", "IsTimedOut")
      VALUES (${row.ParticipantGuid}, ${row.GenericTaskId}, ${isTimedOut})
      RETURNING "Id"
    `;
    const submissionId = subRows[0].Id;
    for (const f of files) {
      await sql`
        INSERT INTO "GenericTaskSubmissionFile" ("SubmissionId", "OriginalFilename", "ContentType", "FileContent", "FileSizeBytes")
        VALUES (${submissionId}, ${f.originalname}, ${f.mimetype || null}, ${f.buffer}, ${f.size})
      `;
    }

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[DB] submit error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// On Vercel this app runs as a serverless function (api/index.mjs imports it) — only bind a port
// when started directly for local dev (npm run serve:api).
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Task App API server listening on http://localhost:${PORT}`);
  });
}

export default app;
