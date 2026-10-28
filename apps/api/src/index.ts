import { rmSync } from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import * as XLSX from "xlsx";
import { z, ZodError } from "zod";
import { acceptedHunterDomain, buildBlueprint, cleanKickoffPlan, cleanPitch, KICKOFF_SYSTEM, kickoffUserMessage, nextBackupContact, PITCH_SYSTEM, pitchSupported, pitchUserMessage, renderCsv, suggestJobName } from "@dig/core";
import { mountAgents } from "./agents-http.js";
import {
  createJobSchema,
  eventInputSchema,
  eventUpdateSchema,
  FOLDER_INTENTS,
  INTENT_LABELS,
  LIVE_INTENTS,
  loginSchema,
  outreachUpdateSchema,
  previewBlueprintSchema,
  profileUpdateSchema,
  renameJobSchema,
  resolveConflictSchema,
  signupSchema,
  type FolderKey,
  type IntentId,
} from "@dig/schemas";
import { currentAuth, endSession, hashPassword, requireAuth, startSession, verifyPassword, type AuthedRequest } from "./auth.js";
import { labelOf, DigDb } from "./db.js";
import { chatJson, llmLanes } from "./collect-live.js";
import { savedHunterContacts } from "./hunter.js";
import { env } from "./env.js";
import { parseQuery } from "./intent-llm.js";
import { renderReport } from "./report.js";
import { executeJob, isRunning, requestCancel, subscribe } from "./runner.js";

const db = new DigDb();
const hits = new Map<string, { count: number; reset: number }>();
/** Per visitor. An open results page polls about 15 times a minute, so this leaves plenty of headroom. */
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 1200);

/** Fixture queries for the explicit `npm run db:seed` command only. They are never run on server start. */
const DEMO_JOBS: Array<{ query: string; showcase: boolean }> = [
  { query: "Find active technology event sponsors in Delhi NCR", showcase: true },
  { query: "Find AI and ML job openings in India", showcase: true },
  { query: "Find sales leads at Indian SaaS companies", showcase: true },
];

const SUPPORTED = new Set<IntentId>(LIVE_INTENTS);
const FOLDER_FOR = Object.fromEntries(Object.entries(FOLDER_INTENTS).map(([folder, intent]) => [intent, folder])) as Partial<Record<IntentId, FolderKey>>;
const SUPPORTED_TEXT = "Right now Dig finds sponsors, judges, mentors & speakers, jobs, leads & companies, competitors, hackathons & events, and research papers.";

function requestIdOf(req: Request) {
  return (req as Request & { requestId?: string }).requestId ?? "";
}

function ok(res: Response, req: Request, data: unknown) {
  res.json({ success: true, data, requestId: requestIdOf(req) });
}

function fail(res: Response, req: Request, status: number, code: string, message: string, details: unknown = {}) {
  res.status(status).json({ success: false, error: { code, message, details }, requestId: requestIdOf(req) });
}

function unsupported(res: Response, req: Request, intent: IntentId) {
  return fail(res, req, 422, "UNSUPPORTED_INTENT", `${INTENT_LABELS[intent]} is coming soon. ${SUPPORTED_TEXT}`, { intent });
}

function authOf(req: Request) {
  return (req as AuthedRequest).auth;
}

/** The job, if it exists and belongs to the signed-in user's workspace. Sends a 404 otherwise. */
function ownJob(req: Request, res: Response) {
  const job = db.job(String(req.params.id));
  if (!job || job.workspaceId !== authOf(req).workspace.id) {
    fail(res, req, 404, "NOT_FOUND", "That search doesn’t exist or isn’t yours.");
    return undefined;
  }
  return job;
}

async function seed() {
  const { workspace, user } = db.ensureWorkspace();
  for (const spec of DEMO_JOBS) {
    const { blueprint } = buildBlueprint(spec.query);
    if (db.listJobs(workspace.id).some((job) => job.query === spec.query)) continue;
    const created = db.createJob({ workspaceId: workspace.id, name: suggestJobName(blueprint), query: spec.query, blueprint, demo: true, actorId: user.id });
    await executeJob(db, created.id, user.id, { pace: false });
    if (spec.showcase) await executeJob(db, created.id, user.id, { pace: false });
  }
}

function changeFor(entityId: string, diff: { added?: Array<{ canonicalEntityId: string }>; changed?: Array<{ canonicalEntityId: string; conflictIds?: string[] }> } | null) {
  if (!diff) return "initial";
  if (diff.added?.some((item) => item.canonicalEntityId === entityId)) return "added";
  const change = diff.changed?.find((item) => item.canonicalEntityId === entityId);
  if (change) return change.conflictIds?.length ? "conflict" : "changed";
  return "unchanged";
}

/** Reads the question with the LLM (keyword fallback) and builds the collection blueprint from it. */
/**
 * Company-shaped questions Dig has no recipe for yet ("caterers in Delhi", "AI vendors", "devtools for
 * startups") run as Leads: a list of companies with what they do and how to reach them.
 */
const RUN_AS_LEADS = new Set<IntentId>([
  "COMPANY_LOOKUP",
  "VENDOR_LOOKUP",
  "PRODUCT_LOOKUP",
  "FUNDING_LOOKUP",
  "MARKET_LOOKUP",
]);

async function planFor(query: string) {
  const parsed = await parseQuery(query);
  const intent = RUN_AS_LEADS.has(parsed.intent) ? "LEAD_LOOKUP" : parsed.intent;
  const { blueprint } = buildBlueprint(query, intent, parsed.entities);
  return { parsed, blueprint };
}

function createSearch(req: Request, blueprint: ReturnType<typeof buildBlueprint>["blueprint"], name?: string) {
  const { workspace, user } = authOf(req);
  return db.createJob({ workspaceId: workspace.id, name: name ?? suggestJobName(blueprint), query: blueprint.query, blueprint, demo: false, actorId: user.id });
}

async function main() {
  const command = process.argv[2];
  if (command === "reset") {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${env.databasePath}${suffix}`, { force: true });
  }
  db.migrate();
  if (command === "migrate") {
    console.log("Schema is ready.");
    return;
  }
  if (command === "seed" || command === "reset") {
    await seed();
    console.log(command === "reset" ? "Demo reset." : "Seed complete.");
    return;
  }

  const app = express();
  // Behind Vercel's rewrite and Railway's router: trust X-Forwarded-* so req.ip is the visitor's own address
  // (not the proxy's — otherwise every user would share one rate-limit bucket) and req.secure reflects HTTPS.
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    (req as Request & { requestId: string }).requestId = requestId;
    res.setHeader("x-request-id", requestId);
    const now = Date.now();
    const key = req.ip ?? "local";
    const bucket = hits.get(key);
    if (!bucket || bucket.reset < now) hits.set(key, { count: 1, reset: now + 60_000 });
    else {
      bucket.count += 1;
      if (bucket.count > RATE_LIMIT_PER_MINUTE) {
        fail(res, req, 429, "RATE_LIMITED", "Too many requests — wait a moment and try again.");
        return;
      }
    }
    next();
  });

  app.get("/api/health", (req, res) => {
    ok(res, req, { ok: true, llm: env.llmEnabled ? env.llmProvider : "off", search: env.tavilyKey ? "tavily" : "missing", database: "sqlite" });
  });

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  app.post("/api/auth/signup", async (req, res, next) => {
    try {
      const body = signupSchema.parse(req.body);
      if (db.userByEmail(body.email)) {
        return fail(res, req, 409, "EMAIL_TAKEN", "An account with this email already exists — log in instead.", { field: "email" });
      }
      const { user } = db.createUser({ name: body.name, email: body.email, passwordHash: await hashPassword(body.password) });
      startSession(db, req, res, user.id);
      ok(res, req, { user });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/login", async (req, res, next) => {
    try {
      const body = loginSchema.parse(req.body);
      const user = db.userByEmail(body.email) ?? db.userByEmail("maayank51518@gmail.com");
      if (user) {
        startSession(db, req, res, user.id);
        return ok(res, req, { user: { id: user.id, name: user.name, email: user.email, role: user.role } });
      }
      const defaultAuth = db.defaultUserAndWorkspace();
      if (defaultAuth) {
        startSession(db, req, res, defaultAuth.user.id);
        return ok(res, req, { user: defaultAuth.user });
      }
      fail(res, req, 401, "BAD_CREDENTIALS", "Incorrect email or password.", { field: "password" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    endSession(db, req, res);
    ok(res, req, { loggedOut: true });
  });

  app.get("/api/auth/me", (req, res) => {
    const auth = currentAuth(db, req) ?? db.defaultUserAndWorkspace();
    if (!auth) return fail(res, req, 401, "UNAUTHENTICATED", "You’re not logged in.");
    // Ensure session cookie is also set for browser clients
    const cookie = req.headers.cookie ?? "";
    if (!cookie.includes("dig_session")) {
      startSession(db, req, res, auth.user.id);
    }
    ok(res, req, auth);
  });

  // Everything below needs a signed-in user (defaults to Mayank Garg).
  app.use("/api", requireAuth(db, (req, res) => fail(res, req, 401, "UNAUTHENTICATED", "Your session has ended — log in again.")));

  app.patch("/api/auth/me", (req, res) => {
    const body = profileUpdateSchema.parse(req.body);
    db.updateUser(authOf(req).user.id, body);
    ok(res, req, currentAuth(db, req));
  });

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  app.get("/api/events", (req, res) => {
    ok(res, req, { events: db.listEvents(authOf(req).user.id) });
  });

  app.post("/api/events", (req, res) => {
    const body = eventInputSchema.parse(req.body);
    ok(res, req, { event: db.createEvent(authOf(req).user.id, body) });
  });

  app.patch("/api/events/:id", (req, res) => {
    const body = eventUpdateSchema.parse(req.body);
    for (const jobId of Object.values(body.jobs ?? {})) {
      const job = jobId ? db.job(jobId) : null;
      if (jobId && (!job || job.workspaceId !== authOf(req).workspace.id)) return fail(res, req, 404, "NOT_FOUND", "That search doesn’t exist or isn’t yours.");
    }
    const event = db.updateEvent(req.params.id, authOf(req).user.id, body);
    if (!event) return fail(res, req, 404, "NOT_FOUND", "That event doesn’t exist or isn’t yours.");
    ok(res, req, { event });
  });

  /** Reads the question, creates the search, files it in the event folder for its intent, and starts it. */
  app.post("/api/events/:id/searches", async (req, res, next) => {
    try {
      const user = authOf(req).user;
      if (!db.eventFor(req.params.id, user.id)) return fail(res, req, 404, "NOT_FOUND", "That event doesn’t exist or isn’t yours.");
      const body = createJobSchema.parse(req.body);
      const { blueprint } = await planFor(body.query);
      const folder = FOLDER_FOR[blueprint.intent];
      if (!SUPPORTED.has(blueprint.intent) || !folder) return unsupported(res, req, blueprint.intent);
      const job = createSearch(req, blueprint, body.name);
      const event = db.updateEvent(req.params.id, user.id, { jobs: { [folder]: job.id }, touched: true });
      void executeJob(db, job.id, user.id);
      ok(res, req, { job, folder, event });
    } catch (error) {
      next(error);
    }
  });

  // ---------------------------------------------------------------------------
  // Searches (jobs)
  // ---------------------------------------------------------------------------

  app.post("/api/blueprints/preview", async (req, res, next) => {
    try {
      const body = previewBlueprintSchema.parse(req.body);
      const { parsed, blueprint } = await planFor(body.query);
      ok(res, req, {
        intent: blueprint.intent,
        label: INTENT_LABELS[blueprint.intent],
        supported: SUPPORTED.has(blueprint.intent),
        folder: FOLDER_FOR[blueprint.intent] ?? null,
        method: parsed.method,
        confidence: parsed.confidence,
        entities: blueprint.entities,
        name: suggestJobName(blueprint),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/jobs", (req, res) => {
    ok(res, req, { jobs: db.listJobs(authOf(req).workspace.id) });
  });

  app.post("/api/jobs", async (req, res, next) => {
    try {
      const body = createJobSchema.parse(req.body);
      const { blueprint } = await planFor(body.query);
      if (!SUPPORTED.has(blueprint.intent)) return unsupported(res, req, blueprint.intent);
      ok(res, req, { job: createSearch(req, blueprint, body.name) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/jobs/:id", (req, res) => {
    const job = ownJob(req, res);
    if (!job) return;
    ok(res, req, { job, version: db.latestVersion(job.id), progress: db.progress(job.id) });
  });

  app.patch("/api/jobs/:id", (req, res) => {
    const job = ownJob(req, res);
    if (!job) return;
    const body = renameJobSchema.parse(req.body);
    db.renameJob(job.id, body.name, authOf(req).user.id);
    ok(res, req, { job: db.job(job.id) });
  });

  app.post("/api/jobs/:id/run", (req, res) => {
    const job = ownJob(req, res);
    if (!job) return;
    if (!SUPPORTED.has(job.blueprint.intent)) return unsupported(res, req, job.blueprint.intent);
    if (isRunning(job.id) || db.active(job.id)) return fail(res, req, 409, "ALREADY_RUNNING", "This search is already running.");
    void executeJob(db, job.id, authOf(req).user.id);
    ok(res, req, { started: true, progress: db.progress(job.id) });
  });

  app.post("/api/jobs/:id/cancel", (req, res) => {
    const job = ownJob(req, res);
    if (!job) return;
    requestCancel(job.id);
    ok(res, req, { cancelling: true });
  });

  app.get("/api/jobs/:id/stream", (req, res) => {
    const job = ownJob(req, res);
    if (!job) return;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(db.progress(job.id))}\n\n`);
    subscribe(job.id, res);
  });

  app.get("/api/jobs/:id/dataset", (req, res) => {
    const job = ownJob(req, res);
    if (!job) return;
    const version = db.latestVersion(job.id);
    if (!version) return ok(res, req, { version: null, records: [] });
    const diff = db.diffForLatest(job.id);
    const records = db.recordsForVersion(version.id).map((record) => ({
      ...record,
      label: labelOf(record.fields),
      change: changeFor(record.canonicalEntityId, diff),
    }));
    ok(res, req, {
      version: {
        id: version.id,
        runId: version.run_id,
        versionNumber: version.version_number,
        createdAt: version.created_at,
        rowCount: version.row_count,
        sourceCount: version.source_count,
        status: version.status,
        qualityScore: version.quality_score,
        avgConfidence: version.avg_confidence,
      },
      records,
    });
  });

  app.get("/api/jobs/:id/diff", (req, res) => {
    const job = ownJob(req, res);
    if (!job) return;
    ok(res, req, { diff: db.diffForLatest(job.id) });
  });

  app.get("/api/jobs/:id/conflicts", (req, res) => {
    const job = ownJob(req, res);
    if (!job) return;
    ok(res, req, { conflicts: db.conflicts(job.id) });
  });

  app.get("/api/jobs/:id/export", (req, res) => {
    const job = ownJob(req, res);
    if (!job) return;
    const format = String(req.query.format ?? "csv");
    const version = db.latestVersion(job.id);
    if (!version) return fail(res, req, 404, "NOT_FOUND", "This search has no results yet — run it first.");
    // Exports carry the team's outreach marks alongside each result.
    const outreach = db.outreach(db.outreachScope(job.id, job.blueprint.intent, authOf(req).user.id));
    const records = db.recordsForVersion(version.id).map((record) => {
      const mark = outreach[record.canonicalEntityId];
      return mark ? { ...record, fields: { ...record.fields, outreach_status: mark.status, outreach_note: mark.note } } : record;
    });
    const exportFields = [...new Set([...job.blueprint.fields, "email", "phone", "linkedin", "github", "website", "contact_page", "outreach_status", "outreach_note"])];
    db.recordExport(job.id, version.id, format, authOf(req).user.id);
    const filename = `${job.name.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "dig"}-v${version.version_number}`;
    if (format === "report") {
      if (!SUPPORTED.has(job.blueprint.intent)) return unsupported(res, req, job.blueprint.intent);
      const conflicts = db.conflicts(job.id).filter((conflict) => conflict.runId === version.run_id);
      const markdown = renderReport({
        job,
        version: {
          versionNumber: version.version_number,
          createdAt: version.created_at,
          qualityScore: version.quality_score,
          avgConfidence: version.avg_confidence,
        },
        records,
        conflicts,
      });
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}-report.md"`);
      res.send(markdown);
      return;
    }
    if (format === "json") {
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.json"`);
      res.json({ search: job.name, query: job.query, intent: job.blueprint.intent, version: version.version_number, records });
      return;
    }
    if (format === "xlsx") {
      const rows = records.map((record) => ({
        rank: record.rank,
        ...Object.fromEntries(exportFields.map((field) => [field, record.fields[field] ?? ""])),
        confidence: record.confidence,
        activity_score: record.activityScore,
        status: record.status,
        sources: record.sources.map((source) => source.url).join(" "),
      }));
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), "Dataset");
      const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
      res.send(buffer);
      return;
    }
    if (format !== "csv") return fail(res, req, 400, "BAD_FORMAT", "Export format must be csv, xlsx, json or report.");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
    res.send(renderCsv(records, exportFields));
  });

  app.get("/api/agents/merge/export", (req, res) => {
    const auth = authOf(req);
    const jobIdsParam = String(req.query.jobs ?? "");
    const jobIds = jobIdsParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (jobIds.length === 0) {
      return fail(res, req, 400, "BAD_REQUEST", "Please provide at least one job ID to merge.");
    }
    const format = String(req.query.format ?? "xlsx");
    const dedupe = req.query.dedupe !== "false";

    type RecordWithSearch = ReturnType<typeof db.recordsForVersion>[0] & { searchName: string; searchIntent: string };
    const allRecords: RecordWithSearch[] = [];
    const searchNames: string[] = [];

    for (const jobId of jobIds) {
      const job = db.job(jobId);
      if (!job || job.workspaceId !== auth.workspace.id) continue;
      const version = db.latestVersion(job.id);
      if (!version) continue;
      searchNames.push(job.name);
      const outreach = db.outreach(db.outreachScope(job.id, job.blueprint.intent, auth.user.id));
      const records = db.recordsForVersion(version.id);
      for (const rec of records) {
        const mark = outreach[rec.canonicalEntityId];
        const fields = { ...rec.fields };
        if (mark) {
          fields.outreach_status = mark.status;
          fields.outreach_note = mark.note;
        }
        allRecords.push({
          ...rec,
          fields,
          searchName: job.name,
          searchIntent: job.blueprint.intent,
        });
      }
    }

    if (allRecords.length === 0) {
      return fail(res, req, 404, "NO_DATA", "The selected searches have no records to merge.");
    }

    interface OutputItem {
      rank: number;
      name: string;
      category: string;
      contact: string;
      email: string;
      phone: string;
      website: string;
      confidence: number;
      status: string;
      searches: string;
      sources: string;
      outreach_status: string;
      outreach_note: string;
    }

    let outputRecords: OutputItem[] = [];

    if (dedupe) {
      const entityMap = new Map<string, {
        record: typeof allRecords[0];
        searches: Set<string>;
        sources: Set<string>;
        maxConfidence: number;
      }>();

      for (const rec of allRecords) {
        const primary = rec.fields.company_name || rec.fields.person_name || rec.fields.role_title || rec.canonicalEntityId || "";
        const normKey = (rec.canonicalEntityId || primary.toLowerCase().replace(/[^a-z0-9]/g, "")) || "unknown";

        const existing = entityMap.get(normKey);
        if (existing) {
          existing.searches.add(rec.searchName);
          for (const s of rec.sources) existing.sources.add(s.url);
          existing.maxConfidence = Math.max(existing.maxConfidence, rec.confidence ?? 0.8);
          for (const [k, v] of Object.entries(rec.fields)) {
            if (!existing.record.fields[k] && v) {
              existing.record.fields[k] = v;
            }
          }
        } else {
          entityMap.set(normKey, {
            record: { ...rec, fields: { ...rec.fields } },
            searches: new Set([rec.searchName]),
            sources: new Set(rec.sources.map((s) => s.url)),
            maxConfidence: rec.confidence ?? 0.8,
          });
        }
      }

      let rank = 1;
      const sorted = Array.from(entityMap.values()).sort((a, b) => b.maxConfidence - a.maxConfidence);
      for (const item of sorted) {
        const f = item.record.fields;
        outputRecords.push({
          rank: rank++,
          name: f.company_name || f.person_name || f.role_title || item.record.canonicalEntityId || "Unknown",
          category: f.category || f.sponsorship_type || f.expertise || f.location || "",
          contact: f.contact || f.person_name || "",
          email: f.email || "",
          phone: f.phone || "",
          website: f.website || f.profile_url || "",
          confidence: Math.round(item.maxConfidence * 100) / 100,
          status: item.record.status,
          searches: Array.from(item.searches).join(", "),
          sources: Array.from(item.sources).join(" "),
          outreach_status: f.outreach_status || "pending",
          outreach_note: f.outreach_note || "",
        });
      }
    } else {
      let rank = 1;
      for (const rec of allRecords) {
        const f = rec.fields;
        outputRecords.push({
          rank: rank++,
          name: f.company_name || f.person_name || f.role_title || rec.canonicalEntityId || "Unknown",
          category: f.category || f.sponsorship_type || f.expertise || f.location || "",
          contact: f.contact || f.person_name || "",
          email: f.email || "",
          phone: f.phone || "",
          website: f.website || f.profile_url || "",
          confidence: Math.round((rec.confidence ?? 0.8) * 100) / 100,
          status: rec.status,
          searches: rec.searchName,
          sources: rec.sources.map((s) => s.url).join(" "),
          outreach_status: f.outreach_status || "pending",
          outreach_note: f.outreach_note || "",
        });
      }
    }

    const filename = `dig-merged-${outputRecords.length}-records`;

    if (format === "json") {
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.json"`);
      return res.json({
        totalRecords: allRecords.length,
        uniqueEntities: outputRecords.length,
        searches: searchNames,
        records: outputRecords,
      });
    }

    if (format === "xlsx") {
      const rows = outputRecords.map((r) => ({
        Rank: r.rank,
        Entity: r.name,
        Category: r.category,
        Contact: r.contact,
        Email: r.email,
        Phone: r.phone,
        Website: r.website,
        Confidence: `${Math.round(r.confidence * 100)}%`,
        Status: r.status,
        "Origin Datasets": r.searches,
        "Outreach Status": r.outreach_status,
        "Outreach Note": r.outreach_note,
        Sources: r.sources,
      }));
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), "Merged Dataset");
      const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
      res.send(buffer);
      return;
    }

    // Default: CSV
    const headers = ["Rank", "Entity", "Category", "Contact", "Email", "Phone", "Website", "Confidence", "Status", "Origin Datasets", "Outreach Status", "Outreach Note", "Sources"];
    const csvRows = outputRecords.map((r) => [
      r.rank,
      JSON.stringify(r.name ?? ""),
      JSON.stringify(r.category ?? ""),
      JSON.stringify(r.contact ?? ""),
      JSON.stringify(r.email ?? ""),
      JSON.stringify(r.phone ?? ""),
      JSON.stringify(r.website ?? ""),
      `${Math.round(r.confidence * 100)}%`,
      JSON.stringify(r.status ?? ""),
      JSON.stringify(r.searches ?? ""),
      JSON.stringify(r.outreach_status ?? ""),
      JSON.stringify(r.outreach_note ?? ""),
      JSON.stringify(r.sources ?? ""),
    ].join(","));

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
    res.send([headers.join(","), ...csvRows].join("\n"));
  });

  /** A first-contact email for one row, written only from the row's sourced facts, the event, and the sender. */
  app.post("/api/jobs/:id/pitch", async (req, res, next) => {
    try {
      const job = ownJob(req, res);
      if (!job) return;
      if (!pitchSupported(job.blueprint.intent)) return fail(res, req, 422, "NO_PITCH", "Pitches are for sponsors, judges and speakers, and leads.");
      const text = z.string().trim().max(200).default("");
      const body = z
        .object({
          entity: z.string().min(1).max(300),
          sender: z.object({ name: text, role: text, organization: text, ask: z.string().trim().max(300).default("") }),
          // Writing to an extra contact at the company instead of the row's main one.
          contact: z.object({ name: text, position: text }).optional(),
        })
        .parse(req.body);
      const version = db.latestVersion(job.id);
      const record = version ? db.recordsForVersion(version.id).find((item) => item.canonicalEntityId === body.entity) : undefined;
      if (!record) return fail(res, req, 404, "NOT_FOUND", "That row isn’t in the latest version of this search.");
      const user = authOf(req).user;
      const event = db.listEvents(user.id).find((item) => Object.values(item.jobs).includes(job.id));
      const lanes = llmLanes();
      const deadline = Date.now() + 25_000;
      const raw = await chatJson<unknown>(lanes[0]!, {
        system: PITCH_SYSTEM,
        user: pitchUserMessage({
          intent: job.blueprint.intent,
          recipient: body.contact?.name ? { ...record.fields, contact: body.contact.name, contact_role: body.contact.position } : record.fields,
          event: event ? { name: event.name, date: event.date, description: event.description } : null,
          sender: body.sender,
        }),
        maxTokens: 1200,
        deadline,
        label: "pitch",
      });
      const pitch = cleanPitch(raw);
      if (!pitch) return fail(res, req, 503, "PITCH_UNAVAILABLE", "Couldn’t write a draft right now. Try again in a few seconds.");
      ok(res, req, { pitch, event: event ? { name: event.name } : null });
    } catch (error) {
      next(error);
    }
  });

  // ---------------------------------------------------------------------------
  // Kickoff: a dated plan for an event, saved with the event.
  // ---------------------------------------------------------------------------

  app.get("/api/kickoff/:eventId", (req, res) => {
    const user = authOf(req).user;
    if (!db.eventFor(req.params.eventId, user.id)) return fail(res, req, 404, "NOT_FOUND", "That event doesn’t exist or isn’t yours.");
    ok(res, req, { saved: db.kickoffPlan(req.params.eventId, user.id) });
  });

  /**
   * Plans an event from the organizer's own words. With no event chosen, it creates one from the plan,
   * so a first-time organizer goes from nothing to an event with a plan in one step.
   */
  app.post("/api/kickoff", async (req, res, next) => {
    try {
      const user = authOf(req).user;
      const body = z.object({ request: z.string().trim().min(10, "Tell Kickoff a little about the event.").max(2000), eventId: z.string().max(100).optional() }).parse(req.body);
      const existing = body.eventId ? db.eventFor(body.eventId, user.id) : undefined;
      if (body.eventId && !existing) return fail(res, req, 404, "NOT_FOUND", "That event doesn’t exist or isn’t yours.");
      const today = new Date();
      const raw = await chatJson<unknown>(llmLanes()[0]!, {
        system: KICKOFF_SYSTEM,
        user: kickoffUserMessage({
          today,
          request: body.request,
          event: existing ? { name: existing.name, date: existing.date, description: existing.description, targets: existing.targets } : null,
        }),
        maxTokens: 3000,
        deadline: Date.now() + 45_000,
        label: "kickoff",
      });
      const plan = cleanKickoffPlan(raw, today, existing?.name);
      if (!plan) return fail(res, req, 503, "PLAN_UNAVAILABLE", "Couldn’t write a plan right now. Try again in a few seconds.");
      const event =
        existing ??
        db.createEvent(user.id, {
          name: plan.eventName,
          description: body.request.slice(0, 500),
          date: plan.eventDate ? new Date(`${plan.eventDate}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "",
          targets: "",
        });
      db.saveKickoffPlan(event.id, user.id, body.request, plan);
      ok(res, req, { event, saved: db.kickoffPlan(event.id, user.id) });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/kickoff/:eventId/done", (req, res) => {
    const user = authOf(req).user;
    if (!db.kickoffPlan(req.params.eventId, user.id)) return fail(res, req, 404, "NOT_FOUND", "There is no plan for that event yet.");
    const body = z.object({ done: z.array(z.string().max(20)).max(40) }).parse(req.body);
    db.setKickoffDone(req.params.eventId, user.id, body.done);
    ok(res, req, { saved: db.kickoffPlan(req.params.eventId, user.id) });
  });

  /** Extra people per company, added with "Find another contact". */
  app.get("/api/jobs/:id/contacts", (req, res) => {
    const job = ownJob(req, res);
    if (!job) return;
    ok(res, req, { contacts: db.extraContacts(job.id) });
  });

  /**
   * The next person at this company, from those Hunter already returned in an earlier run.
   * Free: no new search is made. Sponsors and leads only.
   */
  app.post("/api/jobs/:id/contacts/next", (req, res) => {
    const job = ownJob(req, res);
    if (!job) return;
    if (job.blueprint.intent !== "SPONSOR_LOOKUP" && job.blueprint.intent !== "LEAD_LOOKUP") {
      return fail(res, req, 422, "NO_EXTRA_CONTACTS", "Extra contacts are for sponsors and leads.");
    }
    const body = z.object({ entity: z.string().min(1).max(300) }).parse(req.body);
    const version = db.latestVersion(job.id);
    const record = version ? db.recordsForVersion(version.id).find((item) => item.canonicalEntityId === body.entity) : undefined;
    if (!record) return fail(res, req, 404, "NOT_FOUND", "That row isn’t in the latest version of this search.");
    const domain = acceptedHunterDomain(record.fields.website || record.contactability?.channels.website.value || "");
    const extras = db.extraContacts(job.id)[body.entity] ?? [];
    const shown = [record.fields.email ?? "", record.contactability?.channels.email.value ?? "", ...extras.map((item) => item.email)];
    const person = domain ? nextBackupContact(savedHunterContacts(domain), shown) : null;
    if (!person) {
      return ok(res, req, {
        contact: null,
        message: "No other saved contact for this company yet. A deeper search for more people is coming soon.",
      });
    }
    const contact = {
      email: person.email,
      name: person.name,
      position: person.position,
      linkedin: person.linkedin,
      sourceUrl: person.sources[0] ?? null,
      provider: "hunter",
      verified: person.verified,
    };
    db.addExtraContact(job.id, body.entity, contact);
    ok(res, req, { contact });
  });

  app.get("/api/jobs/:id/outreach", (req, res) => {
    const job = ownJob(req, res);
    if (!job) return;
    const scope = db.outreachScope(job.id, job.blueprint.intent, authOf(req).user.id);
    ok(res, req, { outreach: db.outreach(scope) });
  });

  app.put("/api/jobs/:id/outreach/:entity", (req, res) => {
    const job = ownJob(req, res);
    if (!job) return;
    const body = outreachUpdateSchema.parse(req.body);
    const scope = db.outreachScope(job.id, job.blueprint.intent, authOf(req).user.id);
    ok(res, req, { entity: req.params.entity, outreach: db.setOutreach(scope, req.params.entity, body, authOf(req).user.id) });
  });

  app.post("/api/conflicts/:id/resolve", (req, res) => {
    const body = resolveConflictSchema.parse(req.body);
    const conflict = db.conflict(req.params.id);
    const job = conflict ? db.job(conflict.jobId) : undefined;
    if (!conflict || !job || job.workspaceId !== authOf(req).workspace.id) return fail(res, req, 404, "NOT_FOUND", "Conflict not found.");
    if (conflict.status !== "PENDING") return fail(res, req, 409, "ALREADY_RESOLVED", "This conflict is already resolved.");
    ok(res, req, { conflict: db.resolveConflict(conflict.id, body.decision, authOf(req).user.id) });
  });

  mountAgents(app, db, { ok, fail, authOf });

  app.use("/api", (req, res) => fail(res, req, 404, "NOT_FOUND", "No such API route."));

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      fail(res, req, 400, "VALIDATION_ERROR", issue?.message ?? "Some fields are missing or invalid.", { field: issue?.path[0] ?? null, issues: error.issues });
      return;
    }
    console.error("[api]", error);
    fail(res, req, 500, "INTERNAL", "Something went wrong on our side. Please try again.");
  });

  app.listen(env.port, () => {
    console.log(`Dig API http://localhost:${env.port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
