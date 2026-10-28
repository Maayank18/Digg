import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CollectionBlueprint, JobState, Schedule } from "@dig/schemas";
import { comparisonKey } from "@dig/core";
import type { AnnotationBatch, IntelligenceReport, PipelineResult, PublishedRecord, WorkflowGraph } from "@dig/core";
import { env } from "./env.js";

type Sql = string | number | bigint | null | Uint8Array;

function copy<T>(row: unknown): T {
  return { ...(row as object) } as T;
}

export class DigDb {
  private db: DatabaseSync;

  constructor(file = env.databasePath) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  /** Safe to run on every start: only creates what is missing, never drops or reseeds. */
  migrate() {
    this.addColumn("gauntlet_hackathons", "room_id", "room_id TEXT");
    this.addColumn("gauntlet_hackathons", "checklist_json", "checklist_json TEXT NOT NULL DEFAULT '[]'");

    const sql = readFileSync(env.schemaPath, "utf8");
    this.db.exec(sql);
    this.addColumn("users", "password_hash", "password_hash TEXT");
    this.addColumn("users", "role", "role TEXT NOT NULL DEFAULT ''");
    this.addColumn("records", "contactability_json", "contactability_json TEXT");
    this.addColumn("records", "trust_json", "trust_json TEXT");
    this.addColumn("events", "hidden_folders_json", "hidden_folders_json TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("gauntlet_hackathons", "room_id", "room_id TEXT");
    this.addColumn("gauntlet_hackathons", "checklist_json", "checklist_json TEXT NOT NULL DEFAULT '[]'");
    this.failDangling();
  }

  private addColumn(table: string, column: string, ddl: string) {
    try {
      const columns = this.all<{ name: string }>(`PRAGMA table_info(${table})`);
      if (columns.length > 0 && !columns.some((item) => item.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      }
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // Accounts and sessions. Every user owns one workspace; jobs are scoped to it.
  // ---------------------------------------------------------------------------

  createUser(input: { name: string; email: string; passwordHash: string }) {
    const now = new Date().toISOString();
    const user = { id: crypto.randomUUID(), name: input.name, email: input.email, role: "" };
    const workspace = { id: crypto.randomUUID(), name: `${input.name}’s workspace` };
    this.transaction(() => {
      this.run(
        "INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, ?)",
        user.id,
        user.name,
        user.email,
        input.passwordHash,
        now,
        now,
      );
      this.run("INSERT INTO workspaces (id, name, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", workspace.id, workspace.name, user.id, now, now);
    });
    return { user, workspace };
  }

  userByEmail(email: string) {
    return this.get<{ id: string; name: string; email: string; role: string; password_hash: string | null }>(
      "SELECT id, name, email, role, password_hash FROM users WHERE email = ?",
      email,
    );
  }

  updateUser(id: string, patch: { name: string; role: string }) {
    this.run("UPDATE users SET name = ?, role = ?, updated_at = ? WHERE id = ?", patch.name, patch.role, new Date().toISOString(), id);
  }

  createSession(tokenHash: string, userId: string, ttlMs: number) {
    const now = Date.now();
    this.run("DELETE FROM sessions WHERE expires_at < ?", new Date(now).toISOString());
    this.run(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      tokenHash,
      userId,
      new Date(now).toISOString(),
      new Date(now + ttlMs).toISOString(),
    );
  }

  deleteSession(tokenHash: string) {
    this.run("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }

  /** The signed-in user and their workspace for a session token, or undefined if it's unknown or expired. */
  session(tokenHash: string) {
    const row = this.get<{ id: string; name: string; email: string; role: string; workspace_id: string; workspace_name: string }>(
      `SELECT u.id, u.name, u.email, u.role, w.id AS workspace_id, w.name AS workspace_name
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN workspaces w ON w.owner_id = u.id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
      tokenHash,
      new Date().toISOString(),
    );
    if (!row) return undefined;
    return {
      user: { id: row.id, name: row.name, email: row.email, role: row.role },
      workspace: { id: row.workspace_id, name: row.workspace_name },
    };
  }

  /** Returns the primary account where the folders and data exist (Mayank Garg). */
  defaultUserAndWorkspace() {
    const row =
      this.get<{ id: string; name: string; email: string; role: string; workspace_id: string; workspace_name: string }>(
        `SELECT u.id, u.name, u.email, u.role, w.id AS workspace_id, w.name AS workspace_name
         FROM users u JOIN workspaces w ON w.owner_id = u.id
         WHERE u.email = ?`,
        "maayank51518@gmail.com",
      ) ??
      this.get<{ id: string; name: string; email: string; role: string; workspace_id: string; workspace_name: string }>(
        `SELECT u.id, u.name, u.email, u.role, w.id AS workspace_id, w.name AS workspace_name
         FROM users u JOIN workspaces w ON w.owner_id = u.id
         ORDER BY (SELECT COUNT(*) FROM events e WHERE e.user_id = u.id) DESC
         LIMIT 1`,
      );
    if (!row) return undefined;
    return {
      user: { id: row.id, name: row.name, email: row.email, role: row.role },
      workspace: { id: row.workspace_id, name: row.workspace_name },
    };
  }

  // ---------------------------------------------------------------------------
  // Events (per user)
  // ---------------------------------------------------------------------------

  listEvents(userId: string) {
    return this.all<EventRow>("SELECT * FROM events WHERE user_id = ? ORDER BY opened_at DESC", userId).map(mapEvent);
  }

  eventFor(id: string, userId: string) {
    const row = this.get<EventRow>("SELECT * FROM events WHERE id = ? AND user_id = ?", id, userId);
    return row ? mapEvent(row) : undefined;
  }

  createEvent(userId: string, input: { name: string; description: string; date: string; targets: string }) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.run(
      `INSERT INTO events (id, user_id, name, description, date, targets, favourite, archived, folder_names_json, jobs_json, opened_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, '{}', '{}', ?, ?, ?)`,
      id,
      userId,
      input.name,
      input.description,
      input.date,
      input.targets,
      now,
      now,
      now,
    );
    return this.eventFor(id, userId)!;
  }

  updateEvent(
    id: string,
    userId: string,
    patch: Partial<{
      name: string;
      description: string;
      date: string;
      targets: string;
      favourite: boolean;
      archived: boolean;
      touched: boolean;
      folderNames: Record<string, string>;
      jobs: Record<string, string | null>;
      hiddenFolders: string[];
    }>,
  ) {
    const current = this.eventFor(id, userId);
    if (!current) return undefined;
    const now = new Date().toISOString();
    const jobs: Record<string, string> = { ...current.jobs };
    for (const [folder, jobId] of Object.entries(patch.jobs ?? {})) {
      if (jobId) jobs[folder] = jobId;
      else delete jobs[folder];
    }
    // Filing a search into a hidden folder shows that folder again, so results are never out of sight.
    const filed = new Set(Object.entries(patch.jobs ?? {}).filter(([, jobId]) => jobId).map(([folder]) => folder));
    const hidden = (patch.hiddenFolders ?? current.hiddenFolders).filter((folder) => !filed.has(folder));
    this.run(
      `UPDATE events SET name = ?, description = ?, date = ?, targets = ?, favourite = ?, archived = ?, folder_names_json = ?, jobs_json = ?, hidden_folders_json = ?, opened_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      patch.name ?? current.name,
      patch.description ?? current.description,
      patch.date ?? current.date,
      patch.targets ?? current.targets,
      (patch.favourite ?? current.favourite) ? 1 : 0,
      (patch.archived ?? current.archived) ? 1 : 0,
      JSON.stringify({ ...current.folderNames, ...patch.folderNames }),
      JSON.stringify(jobs),
      JSON.stringify([...new Set(hidden)]),
      patch.touched ? now : current.openedAt,
      now,
      id,
      userId,
    );
    return this.eventFor(id, userId);
  }

  /** Where a search's outreach marks live: its event folder if it is filed in one, else the search itself. */
  outreachScope(jobId: string, intent: string, userId: string) {
    const event = this.get<{ id: string }>(
      "SELECT id FROM events WHERE user_id = ? AND jobs_json LIKE ? ORDER BY opened_at DESC LIMIT 1",
      userId,
      `%"${jobId}"%`,
    );
    return event ? `${event.id}:${intent}` : `job:${jobId}`;
  }

  kickoffPlan(eventId: string, userId: string) {
    const row = this.get<{ request: string; plan_json: string; done_json: string; updated_at: string }>(
      "SELECT request, plan_json, done_json, updated_at FROM kickoff_plans WHERE event_id = ? AND user_id = ?",
      eventId,
      userId,
    );
    if (!row) return null;
    return { request: row.request, plan: JSON.parse(row.plan_json) as unknown, done: JSON.parse(row.done_json) as string[], updatedAt: row.updated_at };
  }

  /** A new plan replaces the old one, and its checkboxes start empty. */
  saveKickoffPlan(eventId: string, userId: string, request: string, plan: unknown) {
    const now = new Date().toISOString();
    this.run(
      `INSERT INTO kickoff_plans (event_id, user_id, request, plan_json, done_json, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET request = excluded.request, plan_json = excluded.plan_json, done_json = '[]', updated_at = excluded.updated_at`,
      eventId,
      userId,
      request,
      JSON.stringify(plan),
      now,
      now,
    );
  }

  setKickoffDone(eventId: string, userId: string, done: string[]) {
    this.run(
      "UPDATE kickoff_plans SET done_json = ?, updated_at = ? WHERE event_id = ? AND user_id = ?",
      JSON.stringify([...new Set(done)]),
      new Date().toISOString(),
      eventId,
      userId,
    );
  }

  /** Extra contacts per company in a search, oldest first, so they show in the order they were added. */
  extraContacts(jobId: string) {
    const rows = this.all<{ canonical_entity_id: string; email: string; name: string; position: string; linkedin: string | null; source_url: string | null; provider: string; verified: number; created_at: string }>(
      "SELECT * FROM extra_contacts WHERE job_id = ? ORDER BY created_at",
      jobId,
    );
    const byEntity: Record<string, Array<{ email: string; name: string; position: string; linkedin: string | null; sourceUrl: string | null; provider: string; verified: boolean }>> = {};
    for (const row of rows) {
      (byEntity[row.canonical_entity_id] ??= []).push({
        email: row.email,
        name: row.name,
        position: row.position,
        linkedin: row.linkedin,
        sourceUrl: row.source_url,
        provider: row.provider,
        verified: Boolean(row.verified),
      });
    }
    return byEntity;
  }

  addExtraContact(jobId: string, entityId: string, contact: { email: string; name: string; position: string; linkedin: string | null; sourceUrl: string | null; provider: string; verified: boolean }) {
    this.run(
      `INSERT OR IGNORE INTO extra_contacts (job_id, canonical_entity_id, email, name, position, linkedin, source_url, provider, verified, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      jobId,
      entityId,
      contact.email,
      contact.name,
      contact.position,
      contact.linkedin,
      contact.sourceUrl,
      contact.provider,
      contact.verified ? 1 : 0,
      new Date().toISOString(),
    );
  }

  outreach(scope: string) {
    const rows = this.all<{ canonical_entity_id: string; status: string; note: string; updated_at: string; updated_by_name: string | null }>(
      `SELECT o.canonical_entity_id, o.status, o.note, o.updated_at, u.name AS updated_by_name
       FROM outreach o LEFT JOIN users u ON u.id = o.updated_by WHERE o.scope = ?`,
      scope,
    );
    return Object.fromEntries(
      rows.map((row) => [row.canonical_entity_id, { status: row.status, note: row.note, updatedAt: row.updated_at, updatedBy: row.updated_by_name }]),
    ) as Record<string, { status: string; note: string; updatedAt: string; updatedBy: string | null }>;
  }

  setOutreach(scope: string, entityId: string, value: { status: string; note: string }, userId: string) {
    this.run(
      `INSERT INTO outreach (scope, canonical_entity_id, status, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope, canonical_entity_id) DO UPDATE SET status = excluded.status, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      scope,
      entityId,
      value.status,
      value.note,
      userId,
      new Date().toISOString(),
    );
    return this.outreach(scope)[entityId];
  }

  renameJob(id: string, name: string, actorId: string) {
    this.run("UPDATE jobs SET name = ?, updated_at = ? WHERE id = ?", name, new Date().toISOString(), id);
    this.audit(actorId, "job.renamed", "job", id, { name });
  }

  private failDangling() {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'FAILED', updated_at = ? WHERE status IN ('QUEUED','COLLECTING','ENRICHING','IDENTITY_RESOLUTION','TRUST_EVALUATION','NORMALIZING','VALIDATING','DEDUPLICATING','RANKING','ANNOTATING')`,
      )
      .run(now);
    this.db
      .prepare(`UPDATE job_runs SET status = 'FAILED', finished_at = ?, error = COALESCE(error, 'Interrupted'), updated_at = ? WHERE finished_at IS NULL`)
      .run(now, now);
  }

  private all<T = Record<string, unknown>>(sql: string, ...params: Sql[]): T[] {
    return this.db.prepare(sql).all(...params).map((row) => copy<T>(row));
  }

  private get<T>(sql: string, ...params: Sql[]): T | undefined {
    const row = this.db.prepare(sql).get(...params);
    return row ? copy<T>(row) : undefined;
  }

  private run(sql: string, ...params: Sql[]) {
    return this.db.prepare(sql).run(...params);
  }

  transaction(fn: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  counts() {
    return {
      jobs: Number(this.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs")?.n ?? 0),
    };
  }

  ensureWorkspace() {
    const existing = this.get<{ id: string; name: string }>("SELECT id, name FROM workspaces LIMIT 1");
    if (existing) {
      const user = this.get<{ id: string; name: string; email: string }>("SELECT id, name, email FROM users WHERE id = (SELECT owner_id FROM workspaces WHERE id = ?)", existing.id);
      return { workspace: existing, user: user! };
    }
    const now = new Date().toISOString();
    const user = { id: crypto.randomUUID(), name: "Demo Operator", email: "demo@dig.local" };
    const workspace = { id: crypto.randomUUID(), name: "Dig Demo" };
    this.transaction(() => {
      this.run("INSERT INTO users (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", user.id, user.name, user.email, now, now);
      this.run(
        "INSERT INTO workspaces (id, name, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        workspace.id,
        workspace.name,
        user.id,
        now,
        now,
      );
    });
    return { workspace, user };
  }

  audit(actorId: string, action: string, entityType: string, entityId: string, metadata?: unknown) {
    this.run(
      "INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, metadata_json, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      actorId,
      action,
      entityType,
      entityId,
      metadata ? JSON.stringify(metadata) : null,
      new Date().toISOString(),
    );
  }

  createJob(input: {
    workspaceId: string;
    name: string;
    query: string;
    blueprint: CollectionBlueprint;
    demo: boolean;
    actorId: string;
    status?: JobState;
  }) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.run(
      `INSERT INTO jobs (id, workspace_id, name, intent, status, query, blueprint_json, schedule_json, demo, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)`,
      id,
      input.workspaceId,
      input.name,
      input.blueprint.intent,
      input.status ?? "PLANNED",
      input.query,
      JSON.stringify(input.blueprint),
      input.demo ? 1 : 0,
      now,
      now,
    );
    this.event(id, null, null, input.status ?? "PLANNED", { created: true });
    this.audit(input.actorId, "job.created", "job", id, { name: input.name });
    return this.job(id)!;
  }

  updateBlueprint(id: string, blueprint: CollectionBlueprint, name: string | undefined, actorId: string) {
    const now = new Date().toISOString();
    this.run(
      `UPDATE jobs SET blueprint_json = ?, intent = ?, name = COALESCE(?, name), updated_at = ?, status = CASE WHEN status = 'DRAFT' THEN 'PLANNED' ELSE status END WHERE id = ?`,
      JSON.stringify(blueprint),
      blueprint.intent,
      name ?? null,
      now,
      id,
    );
    this.audit(actorId, "job.modified", "job", id, { name });
  }

  setSchedule(id: string, schedule: Schedule, actorId: string) {
    this.run("UPDATE jobs SET schedule_json = ?, updated_at = ? WHERE id = ?", JSON.stringify(schedule), new Date().toISOString(), id);
    this.audit(actorId, "job.modified", "job", id, { schedule });
  }

  archive(id: string, actorId: string) {
    this.run("UPDATE jobs SET archived = 1, updated_at = ? WHERE id = ?", new Date().toISOString(), id);
    this.audit(actorId, "job.modified", "job", id, { archived: true });
  }

  setStatus(id: string, status: JobState, previous: string | null, runId: string | null, metadata?: unknown, error?: string | null) {
    this.run("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?", status, new Date().toISOString(), id);
    this.event(id, runId, previous, status, metadata, error);
  }

  event(jobId: string, runId: string | null, previous: string | null, next: string, metadata?: unknown, error?: string | null) {
    this.run(
      `INSERT INTO job_events (id, job_id, run_id, previous_state, next_state, timestamp, duration_ms, metadata_json, error)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      crypto.randomUUID(),
      jobId,
      runId,
      previous,
      next,
      new Date().toISOString(),
      metadata ? JSON.stringify(metadata) : null,
      error ?? null,
    );
  }

  job(id: string) {
    const row = this.get<JobRow>("SELECT * FROM jobs WHERE id = ?", id);
    return row ? mapJob(row) : undefined;
  }

  listJobs(workspaceId: string) {
    const rows = this.all<JobRow & VersionRow>(
      `SELECT j.*, dv.version_number, dv.row_count, dv.source_count, dv.quality_score, dv.avg_confidence, dv.id AS version_id,
              r.finished_at AS last_run_at, r.diff_json, r.id AS run_id,
              (SELECT COUNT(*) FROM conflicts c WHERE c.job_id = j.id AND c.status = 'PENDING') AS pending_conflicts
       FROM jobs j
       LEFT JOIN dataset_versions dv ON dv.id = (
         SELECT id FROM dataset_versions WHERE job_id = j.id ORDER BY version_number DESC LIMIT 1
       )
       LEFT JOIN job_runs r ON r.id = dv.run_id
       WHERE j.workspace_id = ? AND j.archived = 0
       ORDER BY j.updated_at DESC`,
      workspaceId,
    );
    return rows.map((row) => ({
      ...mapJob(row),
      versionNumber: row.version_number ?? null,
      versionId: row.version_id ?? null,
      rowCount: row.row_count ?? 0,
      sourceCount: row.source_count ?? 0,
      qualityScore: row.quality_score ?? null,
      avgConfidence: row.avg_confidence ?? null,
      lastRunAt: row.last_run_at ?? null,
      pendingConflicts: Number(row.pending_conflicts ?? 0),
      diff: summarizeDiff(row.diff_json),
    }));
  }

  nextRunNumber(jobId: string) {
    return Number(this.get<{ n: number }>("SELECT COALESCE(MAX(run_number), 0) + 1 AS n FROM job_runs WHERE job_id = ?", jobId)?.n ?? 1);
  }

  createRun(jobId: string, runNumber: number) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.run(
      `INSERT INTO job_runs (id, job_id, run_number, status, started_at, finished_at, stats_json, progress_json, diff_json, report_json, llm_json, error, created_at, updated_at)
       VALUES (?, ?, ?, 'QUEUED', ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      id,
      jobId,
      runNumber,
      now,
      JSON.stringify(emptyProgress("QUEUED")),
      now,
      now,
    );
    return id;
  }

  updateProgress(runId: string, jobId: string, status: string, progress: Progress) {
    const now = new Date().toISOString();
    this.run("UPDATE job_runs SET status = ?, progress_json = ?, updated_at = ? WHERE id = ?", status, JSON.stringify(progress), now, runId);
    this.run("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?", status, now, jobId);
  }

  finishRun(input: {
    runId: string;
    jobId: string;
    status: JobState;
    result?: PipelineResult;
    error?: string | null;
    actorId: string;
  }) {
    const now = new Date().toISOString();
    if (!input.result) {
      this.run(
        "UPDATE job_runs SET status = ?, finished_at = ?, error = ?, updated_at = ? WHERE id = ?",
        input.status,
        now,
        input.error ?? null,
        now,
        input.runId,
      );
      this.setStatus(input.jobId, input.status, null, input.runId, undefined, input.error);
      return;
    }
    const result = input.result;
    const versionId = crypto.randomUUID();
    const versionNumber = Number(
      this.get<{ n: number }>("SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM dataset_versions WHERE job_id = ?", input.jobId)?.n ?? 1,
    );
    this.transaction(() => {
      this.run(
        `INSERT INTO dataset_versions (id, job_id, run_id, version_number, created_at, updated_at, row_count, source_count, status, quality_score, avg_confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        versionId,
        input.jobId,
        input.runId,
        versionNumber,
        now,
        now,
        result.records.length,
        result.stats.sources,
        input.status,
        result.stats.qualityScore,
        result.stats.avgConfidence,
      );
      const sourceIds = new Map<string, string>();
      for (const record of result.records) {
        for (const source of record.sources) {
          if (sourceIds.has(source.url)) continue;
          const sourceId = crypto.randomUUID();
          sourceIds.set(source.url, sourceId);
          this.run(
            `INSERT INTO sources (id, job_id, dataset_version_id, url, title, domain, collected_at, published_at, content_hash, extraction_method, source_type, authority, demo, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            sourceId,
            input.jobId,
            versionId,
            source.url,
            source.title,
            source.domain,
            now,
            source.publishedAt,
            source.url,
            source.extractionMethod,
            source.sourceType,
            source.authority,
            source.demo ? 1 : 0,
            now,
            now,
          );
          this.run(
            `INSERT INTO raw_documents (id, source_id, job_id, run_id, url, raw_text, metadata_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            crypto.randomUUID(),
            sourceId,
            input.jobId,
            input.runId,
            source.url,
            source.excerpt,
            JSON.stringify({ title: source.title, demo: source.demo }),
            now,
            now,
          );
        }
        this.run(
          `INSERT INTO records (id, job_id, dataset_version_id, canonical_entity_id, fields_json, rank, activity_score, activity_components_json, confidence, confidence_components_json, status, validation_json, source_count, content_hash, flags_json, alternates_json, sources_json, annotation_json, contactability_json, trust_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          record.id,
          input.jobId,
          versionId,
          record.canonicalEntityId,
          JSON.stringify(record.fields),
          record.rank,
          record.activityScore,
          JSON.stringify(record.activityComponents),
          record.confidence,
          JSON.stringify(record.confidenceComponents),
          record.status,
          JSON.stringify(record.validation),
          record.sourceCount,
          record.contentHash,
          JSON.stringify(record.flags),
          JSON.stringify(record.alternates),
          JSON.stringify(record.sources),
          JSON.stringify(record.annotation),
          record.contactability ? JSON.stringify(record.contactability) : null,
          record.trust ? JSON.stringify(record.trust) : null,
          now,
          now,
        );
        this.run(
          `INSERT INTO record_versions (id, record_id, job_id, canonical_entity_id, dataset_version_id, field_values_json, content_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          crypto.randomUUID(),
          record.id,
          input.jobId,
          record.canonicalEntityId,
          versionId,
          JSON.stringify(record.fields),
          record.contentHash,
          now,
        );
        this.run(
          `INSERT INTO annotations (id, record_id, job_id, dataset_version_id, remark, reasoning, confidence, input_hash, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          crypto.randomUUID(),
          record.id,
          input.jobId,
          versionId,
          record.annotation.remark,
          record.annotation.reasoning,
          record.annotation.confidence,
          result.annotationHash,
          result.model,
          now,
        );
        for (const item of record.evidence) {
          this.run(
            `INSERT INTO evidence (id, record_id, job_id, dataset_version_id, canonical_entity_id, field_name, value, source_id, source_url, source_title, excerpt, collected_at, published_at, authority, confidence, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            item.id,
            record.id,
            input.jobId,
            versionId,
            record.canonicalEntityId,
            item.fieldName,
            item.value,
            sourceIds.get(item.sourceUrl) ?? null,
            item.sourceUrl,
            item.sourceTitle,
            item.excerpt,
            item.collectedAt,
            item.publishedAt,
            item.authority,
            item.confidence,
            now,
          );
        }
      }
      // One live conflict per open question. A pending conflict from an earlier version that this run raises
      // again is carried forward (same id, original detection date); any other earlier pending conflict is
      // superseded, because this version either settled it or replaced it with a different disagreement.
      const questionKey = (entity: string, field: string, from: string, to: string) =>
        [entity, field, comparisonKey(field, from), comparisonKey(field, to)].join(" | ");
      const openEarlier = new Map(
        this.all<{ id: string; canonical_entity_id: string; field: string; old_value: string; new_value: string }>(
          "SELECT id, canonical_entity_id, field, old_value, new_value FROM conflicts WHERE job_id = ? AND status = 'PENDING' AND run_id != ?",
          input.jobId,
          input.runId,
        ).map((row) => [questionKey(row.canonical_entity_id, row.field, row.old_value, row.new_value), row.id]),
      );
      const carriedIds = new Map<string, string>();
      for (const conflict of result.conflicts) {
        const record = result.records.find((item) => item.canonicalEntityId === conflict.canonicalEntityId);
        const earlierId = conflict.status === "PENDING"
          ? openEarlier.get(questionKey(conflict.canonicalEntityId, conflict.field, conflict.oldValue, conflict.newValue))
          : undefined;
        if (earlierId) {
          openEarlier.delete(questionKey(conflict.canonicalEntityId, conflict.field, conflict.oldValue, conflict.newValue));
          carriedIds.set(conflict.id, earlierId);
          this.run(
            `UPDATE conflicts SET run_id = ?, record_id = ?, new_value = ?, new_evidence_json = ?, confidence = ?, reason = ?, updated_at = ? WHERE id = ?`,
            input.runId,
            record?.id ?? null,
            conflict.newValue,
            JSON.stringify(conflict.newEvidence),
            conflict.confidence,
            conflict.reason,
            now,
            earlierId,
          );
          continue;
        }
        this.run(
          `INSERT INTO conflicts (id, job_id, run_id, record_id, canonical_entity_id, field, old_value, new_value, old_evidence_json, new_evidence_json, detected_at, status, decision, confidence, reason, resolved_at, resolved_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          conflict.id,
          input.jobId,
          input.runId,
          record?.id ?? null,
          conflict.canonicalEntityId,
          conflict.field,
          conflict.oldValue,
          conflict.newValue,
          JSON.stringify(conflict.oldEvidence),
          JSON.stringify(conflict.newEvidence),
          conflict.detectedAt,
          conflict.status,
          conflict.decision,
          conflict.confidence,
          conflict.reason,
          conflict.status === "AUTO_RESOLVED" ? now : null,
          conflict.status === "AUTO_RESOLVED" ? (conflict.provider === "jev" ? "jev" : "rules") : null,
          now,
          now,
        );
      }
      for (const staleId of openEarlier.values()) {
        this.run(
          "UPDATE conflicts SET status = 'SUPERSEDED', resolved_at = ?, resolved_by = 'superseded', updated_at = ? WHERE id = ?",
          now,
          now,
          staleId,
        );
      }
      // The diff refers to conflicts by id; point carried-forward ones at the row that actually exists.
      if (carriedIds.size > 0) {
        const remap = (ids: string[]) => ids.map((id) => carriedIds.get(id) ?? id);
        result.diff.conflictIds = remap(result.diff.conflictIds);
        for (const change of result.diff.changed) change.conflictIds = remap(change.conflictIds ?? []);
      }
      this.run(
        `UPDATE job_runs SET status = ?, finished_at = ?, stats_json = ?, diff_json = ?, report_json = ?, llm_json = ?, progress_json = ?, updated_at = ? WHERE id = ?`,
        input.status,
        now,
        JSON.stringify(result.stats),
        JSON.stringify(result.diff),
        JSON.stringify(result.report),
        JSON.stringify({ calls: result.stats.llmCalls, cacheHit: result.stats.llmCacheHit, model: result.model, cost: null }),
        JSON.stringify({
          ...emptyProgress(input.status),
          sourcesScanned: result.stats.sources,
          sourcesPlanned: result.stats.sources,
          documents: result.stats.documents,
          records: result.stats.records,
          valid: result.stats.valid,
          duplicates: result.stats.duplicates,
          conflicts: result.stats.conflicts,
          percent: 100,
        }),
        now,
        input.runId,
      );
      this.run("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?", input.status, now, input.jobId);
      this.run(
        `INSERT INTO job_events (id, job_id, run_id, previous_state, next_state, timestamp, duration_ms, metadata_json, error)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
        crypto.randomUUID(),
        input.jobId,
        input.runId,
        "ANNOTATING",
        input.status,
        now,
        JSON.stringify({ records: result.records.length, conflicts: result.conflicts.length }),
      );
    });
    this.audit(input.actorId, "job.run", "job", input.jobId, { runId: input.runId, status: input.status });
  }

  latestRecords(jobId: string): PublishedRecord[] {
    const version = this.latestVersion(jobId);
    if (!version) return [];
    return this.recordsForVersion(version.id);
  }

  latestVersion(jobId: string) {
    return this.get<Version>("SELECT * FROM dataset_versions WHERE job_id = ? ORDER BY version_number DESC LIMIT 1", jobId);
  }

  recordsForVersion(versionId: string): PublishedRecord[] {
    const rows = this.all<RecordRow>("SELECT * FROM records WHERE dataset_version_id = ? ORDER BY rank ASC", versionId);
    return rows.map((row) => ({
      id: row.id,
      canonicalEntityId: row.canonical_entity_id,
      fields: JSON.parse(row.fields_json) as Record<string, string>,
      rank: row.rank,
      activityScore: row.activity_score,
      activityComponents: JSON.parse(row.activity_components_json),
      confidence: row.confidence,
      confidenceComponents: JSON.parse(row.confidence_components_json),
      status: row.status as PublishedRecord["status"],
      validation: JSON.parse(row.validation_json),
      sourceCount: row.source_count,
      contentHash: row.content_hash,
      flags: JSON.parse(row.flags_json),
      alternates: JSON.parse(row.alternates_json),
      sources: JSON.parse(row.sources_json),
      evidence: this.all<EvidenceRow>("SELECT * FROM evidence WHERE record_id = ?", row.id).map(mapEvidence),
      annotation: JSON.parse(row.annotation_json),
      contactability: row.contactability_json ? JSON.parse(row.contactability_json) : undefined,
      trust: row.trust_json ? JSON.parse(row.trust_json) : undefined,
    }));
  }

  runs(jobId: string) {
    return this.all(
      `SELECT id, run_number, status, started_at, finished_at, stats_json, diff_json, error FROM job_runs WHERE job_id = ? ORDER BY run_number DESC`,
      jobId,
    ).map((row) => {
      const stats = row.stats_json ? JSON.parse(String(row.stats_json)) : null;
      const diff = summarizeDiff(row.diff_json ? String(row.diff_json) : null);
      return {
        id: String(row.id),
        runNumber: Number(row.run_number),
        status: String(row.status),
        startedAt: String(row.started_at),
        finishedAt: row.finished_at ? String(row.finished_at) : null,
        error: row.error ? String(row.error) : null,
        stats,
        diff,
      };
    });
  }

  events(jobId: string) {
    return this.all(
      "SELECT id, previous_state, next_state, timestamp, metadata_json, error FROM job_events WHERE job_id = ? ORDER BY timestamp ASC",
      jobId,
    ).map((row) => ({
      id: String(row.id),
      previousState: row.previous_state ? String(row.previous_state) : null,
      nextState: String(row.next_state),
      timestamp: String(row.timestamp),
      metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null,
      error: row.error ? String(row.error) : null,
    }));
  }

  progress(jobId: string) {
    const job = this.job(jobId);
    const run = this.get<RunRow>(
      "SELECT * FROM job_runs WHERE job_id = ? ORDER BY run_number DESC LIMIT 1",
      jobId,
    );
    return {
      status: job?.status ?? "DRAFT",
      runId: run?.id ?? null,
      runNumber: run?.run_number ?? null,
      progress: run?.progress_json ? JSON.parse(run.progress_json) : emptyProgress(job?.status ?? "DRAFT"),
      error: run?.error ?? null,
    };
  }

  diffForLatest(jobId: string) {
    const run = this.get<{ diff_json: string | null }>(
      `SELECT r.diff_json FROM job_runs r
       JOIN dataset_versions dv ON dv.run_id = r.id
       WHERE dv.job_id = ?
       ORDER BY dv.version_number DESC LIMIT 1`,
      jobId,
    );
    return run?.diff_json ? JSON.parse(run.diff_json) : null;
  }

  report(jobId: string): IntelligenceReport | null {
    const run = this.get<{ report_json: string | null }>(
      `SELECT r.report_json FROM job_runs r JOIN dataset_versions dv ON dv.run_id = r.id WHERE dv.job_id = ? ORDER BY dv.version_number DESC LIMIT 1`,
      jobId,
    );
    return run?.report_json ? (JSON.parse(run.report_json) as IntelligenceReport) : null;
  }

  conflicts(jobId?: string) {
    const rows = jobId
      ? this.all("SELECT c.*, j.name AS job_name, r.fields_json FROM conflicts c JOIN jobs j ON j.id = c.job_id LEFT JOIN records r ON r.id = c.record_id WHERE c.job_id = ? ORDER BY CASE c.status WHEN 'PENDING' THEN 0 ELSE 1 END, c.detected_at DESC", jobId)
      : this.all("SELECT c.*, j.name AS job_name, r.fields_json FROM conflicts c JOIN jobs j ON j.id = c.job_id LEFT JOIN records r ON r.id = c.record_id WHERE j.archived = 0 ORDER BY CASE c.status WHEN 'PENDING' THEN 0 ELSE 1 END, c.detected_at DESC LIMIT 100");
    return rows.map(mapConflict);
  }

  conflict(id: string) {
    const row = this.get<Record<string, unknown>>("SELECT c.*, j.name AS job_name, r.fields_json FROM conflicts c JOIN jobs j ON j.id = c.job_id LEFT JOIN records r ON r.id = c.record_id WHERE c.id = ?", id);
    return row ? mapConflict(row) : undefined;
  }

  resolveConflict(id: string, decision: "NEW" | "OLD" | "BOTH", actorId: string) {
    const current = this.conflict(id);
    if (!current) return undefined;
    const now = new Date().toISOString();
    const record = current.recordId
      ? this.get<RecordRow>("SELECT * FROM records WHERE id = ?", current.recordId)
      : undefined;
    if (record) {
      const fields = JSON.parse(record.fields_json) as Record<string, string>;
      const alternates = JSON.parse(record.alternates_json) as Array<{ field: string; value: string }>;
      if (decision === "NEW") fields[current.field] = current.newValue;
      if (decision === "OLD") fields[current.field] = current.oldValue;
      if (decision === "BOTH") {
        fields[current.field] = current.oldValue;
        alternates.push({ field: current.field, value: current.newValue });
      }
      const pendingLeft = this.all(
        "SELECT id FROM conflicts WHERE record_id = ? AND status = 'PENDING' AND id != ?",
        record.id,
        id,
      );
      const status = pendingLeft.length ? "needs_review" : record.status === "needs_review" ? "verified" : record.status;
      this.run(
        "UPDATE records SET fields_json = ?, alternates_json = ?, status = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(fields),
        JSON.stringify(alternates),
        status,
        now,
        record.id,
      );
      this.run(
        "INSERT INTO record_versions (id, record_id, job_id, canonical_entity_id, dataset_version_id, field_values_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        crypto.randomUUID(),
        record.id,
        record.job_id,
        record.canonical_entity_id,
        record.dataset_version_id,
        JSON.stringify(fields),
        record.content_hash,
        now,
      );
    }
    this.run(
      "UPDATE conflicts SET status = 'HUMAN_RESOLVED', decision = ?, resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?",
      decision,
      now,
      actorId,
      now,
      id,
    );
    const pending = Number(this.get<{ n: number }>("SELECT COUNT(*) AS n FROM conflicts WHERE job_id = ? AND status = 'PENDING'", current.jobId)?.n ?? 0);
    if (pending === 0) {
      const job = this.job(current.jobId);
      if (job?.status === "CONFLICT_REVIEW") this.run("UPDATE jobs SET status = 'COMPLETED', updated_at = ? WHERE id = ?", now, current.jobId);
    }
    this.audit(actorId, "conflict.resolved", "conflict", id, { decision });
    return this.conflict(id);
  }

  sources(jobId?: string) {
    const rows = jobId
      ? this.all(
          `SELECT * FROM sources WHERE dataset_version_id = (SELECT id FROM dataset_versions WHERE job_id = ? ORDER BY version_number DESC LIMIT 1) ORDER BY title ASC`,
          jobId,
        )
      : this.all(
          `SELECT s.*, j.name AS job_name FROM sources s JOIN jobs j ON j.id = s.job_id
           WHERE s.dataset_version_id IN (SELECT id FROM dataset_versions dv WHERE dv.version_number = (SELECT MAX(version_number) FROM dataset_versions WHERE job_id = dv.job_id))
           ORDER BY s.collected_at DESC LIMIT 200`,
        );
    return rows.map((row) => ({
      id: String(row.id),
      jobId: String(row.job_id),
      jobName: row.job_name ? String(row.job_name) : undefined,
      url: String(row.url),
      title: String(row.title),
      domain: String(row.domain),
      collectedAt: String(row.collected_at),
      publishedAt: row.published_at ? String(row.published_at) : null,
      extractionMethod: String(row.extraction_method),
      sourceType: String(row.source_type),
      authority: String(row.authority),
      demo: Boolean(row.demo),
    }));
  }

  datasets() {
    return this.all(
      `SELECT dv.*, j.name AS job_name, j.intent, j.status AS job_status FROM dataset_versions dv JOIN jobs j ON j.id = dv.job_id WHERE j.archived = 0 ORDER BY dv.created_at DESC`,
    ).map((row) => ({
      id: String(row.id),
      jobId: String(row.job_id),
      jobName: String(row.job_name),
      intent: String(row.intent),
      jobStatus: String(row.job_status),
      versionNumber: Number(row.version_number),
      createdAt: String(row.created_at),
      rowCount: Number(row.row_count),
      sourceCount: Number(row.source_count),
      status: String(row.status),
      qualityScore: row.quality_score === null ? null : Number(row.quality_score),
      avgConfidence: row.avg_confidence === null ? null : Number(row.avg_confidence),
    }));
  }

  reports() {
    return this.all(
      `SELECT r.id AS run_id, r.report_json, r.finished_at, j.id AS job_id, j.name, dv.version_number
       FROM job_runs r
       JOIN jobs j ON j.id = r.job_id
       JOIN dataset_versions dv ON dv.run_id = r.id
       WHERE r.report_json IS NOT NULL AND j.archived = 0
       ORDER BY r.finished_at DESC`,
    ).map((row) => {
      const report = JSON.parse(String(row.report_json)) as IntelligenceReport;
      return {
        runId: String(row.run_id),
        jobId: String(row.job_id),
        jobName: String(row.name),
        versionNumber: Number(row.version_number),
        title: report.title,
        summary: report.summary,
        generatedAt: report.generatedAt,
        demo: report.demo,
      };
    });
  }

  history(jobId: string, entityId: string) {
    return this.all(
      `SELECT rv.field_values_json, rv.created_at, dv.version_number
       FROM record_versions rv JOIN dataset_versions dv ON dv.id = rv.dataset_version_id
       WHERE rv.job_id = ? AND rv.canonical_entity_id = ?
       ORDER BY dv.version_number ASC, rv.created_at ASC`,
      jobId,
      entityId,
    ).map((row) => ({
      versionNumber: Number(row.version_number),
      createdAt: String(row.created_at),
      fields: JSON.parse(String(row.field_values_json)) as Record<string, string>,
    }));
  }

  views(jobId: string) {
    return this.all("SELECT * FROM saved_views WHERE job_id = ? ORDER BY created_at DESC", jobId).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      filters: JSON.parse(String(row.filters_json)),
    }));
  }

  saveView(jobId: string, name: string, filters: unknown) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.run(
      "INSERT INTO saved_views (id, job_id, name, filters_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      jobId,
      name,
      JSON.stringify(filters),
      now,
      now,
    );
    return { id, name, filters };
  }

  readCache(hash: string): AnnotationBatch | null {
    const row = this.get<{ output_json: string }>("SELECT output_json FROM llm_cache WHERE input_hash = ?", hash);
    return row ? (JSON.parse(row.output_json) as AnnotationBatch) : null;
  }

  writeCache(hash: string, model: string, batch: AnnotationBatch) {
    this.run(
      "INSERT OR REPLACE INTO llm_cache (input_hash, model, output_json, created_at) VALUES (?, ?, ?, ?)",
      hash,
      model,
      JSON.stringify(batch),
      new Date().toISOString(),
    );
  }

  recordExport(jobId: string, versionId: string | null, format: string, actorId: string) {
    this.run(
      "INSERT INTO exports (id, job_id, dataset_version_id, format, created_at) VALUES (?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      jobId,
      versionId,
      format,
      new Date().toISOString(),
    );
    this.audit(actorId, "export.generated", "job", jobId, { format });
  }

  dueJobs() {
    const now = new Date().toISOString();
    return this.all<JobRow>("SELECT * FROM jobs WHERE archived = 0 AND schedule_json IS NOT NULL").flatMap((row) => {
      const schedule = row.schedule_json ? (JSON.parse(row.schedule_json) as Schedule) : null;
      if (!schedule?.enabled || !schedule.nextRunAt || schedule.nextRunAt > now) return [];
      return [mapJob(row)];
    });
  }

  active(jobId: string) {
    const job = this.job(jobId);
    return Boolean(job && ["QUEUED", "COLLECTING", "ENRICHING", "IDENTITY_RESOLUTION", "TRUST_EVALUATION", "NORMALIZING", "VALIDATING", "DEDUPLICATING", "RANKING", "ANNOTATING"].includes(job.status));
  }

  listWorkflows(workspaceId: string) {
    return this.all<{ id: string; name: string; template_id: string | null; updated_at: string; version_number: number | null; version_id: string | null }>(
      `SELECT w.id, w.name, w.template_id, w.updated_at, v.version_number, v.id AS version_id
       FROM workflows w
       LEFT JOIN workflow_versions v ON v.id = (
         SELECT id FROM workflow_versions WHERE workflow_id = w.id ORDER BY version_number DESC LIMIT 1
       )
       WHERE w.workspace_id = ?
       ORDER BY w.updated_at DESC`,
      workspaceId,
    ).map((row) => ({
      id: row.id,
      name: row.name,
      templateId: row.template_id,
      updatedAt: row.updated_at,
      versionNumber: row.version_number,
      versionId: row.version_id,
    }));
  }

  workflow(id: string) {
    const row = this.get<{ id: string; workspace_id: string; name: string; template_id: string | null; updated_at: string }>(
      "SELECT id, workspace_id, name, template_id, updated_at FROM workflows WHERE id = ?",
      id,
    );
    if (!row) return undefined;
    const version = this.latestWorkflowVersion(id);
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      templateId: row.template_id,
      updatedAt: row.updated_at,
      versionId: version?.id ?? null,
      versionNumber: version?.version_number ?? null,
      graph: version ? (JSON.parse(version.graph_json) as WorkflowGraph) : { nodes: [], edges: [] },
    };
  }

  createWorkflow(input: { workspaceId: string; name: string; templateId?: string | null; graph: WorkflowGraph; actorId: string }) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    this.transaction(() => {
      this.run(
        "INSERT INTO workflows (id, workspace_id, name, template_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        input.workspaceId,
        input.name,
        input.templateId ?? null,
        now,
        now,
      );
      this.run(
        "INSERT INTO workflow_versions (id, workflow_id, version_number, graph_json, created_at) VALUES (?, ?, 1, ?, ?)",
        versionId,
        id,
        JSON.stringify(input.graph),
        now,
      );
    });
    this.audit(input.actorId, "workflow.created", "workflow", id, { name: input.name });
    return this.workflow(id)!;
  }

  saveWorkflow(id: string, input: { name?: string; graph: WorkflowGraph; actorId: string }) {
    const current = this.workflow(id);
    if (!current) return undefined;
    const now = new Date().toISOString();
    const latest = this.latestWorkflowVersion(id);
    const same = latest && latest.graph_json === JSON.stringify(input.graph);
    const runs = latest
      ? Number(this.get<{ n: number }>("SELECT COUNT(*) AS n FROM workflow_runs WHERE version_id = ?", latest.id)?.n ?? 0)
      : 0;
    this.transaction(() => {
      this.run("UPDATE workflows SET name = ?, updated_at = ? WHERE id = ?", input.name ?? current.name, now, id);
      if (!latest) {
        this.run(
          "INSERT INTO workflow_versions (id, workflow_id, version_number, graph_json, created_at) VALUES (?, ?, 1, ?, ?)",
          crypto.randomUUID(),
          id,
          JSON.stringify(input.graph),
          now,
        );
      } else if (!same && runs === 0) {
        this.run("UPDATE workflow_versions SET graph_json = ? WHERE id = ?", JSON.stringify(input.graph), latest.id);
      } else if (!same) {
        this.run(
          "INSERT INTO workflow_versions (id, workflow_id, version_number, graph_json, created_at) VALUES (?, ?, ?, ?, ?)",
          crypto.randomUUID(),
          id,
          latest.version_number + 1,
          JSON.stringify(input.graph),
          now,
        );
      }
    });
    this.audit(input.actorId, "workflow.saved", "workflow", id, { versioned: !same && runs > 0 });
    return this.workflow(id);
  }

  findUnusedTemplateWorkflow(workspaceId: string, templateId: string) {
    const row = this.get<{ id: string }>(
      `SELECT w.id FROM workflows w
       LEFT JOIN workflow_runs r ON r.workflow_id = w.id
       WHERE w.workspace_id = ? AND w.template_id = ?
       GROUP BY w.id
       HAVING COUNT(r.id) = 0
       ORDER BY w.updated_at DESC LIMIT 1`,
      workspaceId,
      templateId,
    );
    return row ? this.workflow(row.id) : undefined;
  }

  countWorkflowsByNamePrefix(workspaceId: string, prefix: string): number {
    const row = this.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM workflows WHERE workspace_id = ? AND name LIKE ?",
      workspaceId,
      `${prefix}%`,
    );
    return Number(row?.n ?? 0);
  }

  deleteWorkflow(id: string, workspaceId: string) {
    return this.transaction(() => {
      const wf = this.get<{ id: string }>("SELECT id FROM workflows WHERE id = ? AND workspace_id = ?", id, workspaceId);
      if (!wf) return false;
      this.run("DELETE FROM workflow_node_runs WHERE run_id IN (SELECT id FROM workflow_runs WHERE workflow_id = ?)", id);
      this.run("DELETE FROM workflow_approvals WHERE run_id IN (SELECT id FROM workflow_runs WHERE workflow_id = ?)", id);
      this.run("DELETE FROM workflow_runs WHERE workflow_id = ?", id);
      this.run("DELETE FROM workflow_versions WHERE workflow_id = ?", id);
      this.run("UPDATE missions SET workflow_id = NULL WHERE workflow_id = ?", id);
      this.run("DELETE FROM workflows WHERE id = ?", id);
      return true;
    });
  }

  private latestWorkflowVersion(workflowId: string) {
    return this.get<{ id: string; version_number: number; graph_json: string }>(
      "SELECT id, version_number, graph_json FROM workflow_versions WHERE workflow_id = ? ORDER BY version_number DESC LIMIT 1",
      workflowId,
    );
  }

  createWorkflowRun(input: { workflowId: string; versionId: string; workspaceId: string; mode: "dry" | "live"; actorId: string }) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.run(
      "INSERT INTO workflow_runs (id, workflow_id, version_id, workspace_id, status, mode, error, started_at, finished_at, created_at) VALUES (?, ?, ?, ?, 'QUEUED', ?, NULL, ?, NULL, ?)",
      id,
      input.workflowId,
      input.versionId,
      input.workspaceId,
      input.mode,
      now,
      now,
    );
    this.audit(input.actorId, "workflow.run", "workflow_run", id, { mode: input.mode, workflowId: input.workflowId });
    return this.workflowRun(id)!;
  }

  workflowRun(id: string) {
    const row = this.get<{ id: string; workflow_id: string; version_id: string; workspace_id: string; status: string; mode: string; error: string | null; started_at: string | null; finished_at: string | null }>(
      "SELECT id, workflow_id, version_id, workspace_id, status, mode, error, started_at, finished_at FROM workflow_runs WHERE id = ?",
      id,
    );
    if (!row) return undefined;
    return {
      id: row.id,
      workflowId: row.workflow_id,
      versionId: row.version_id,
      workspaceId: row.workspace_id,
      status: row.status,
      mode: row.mode,
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      nodeRuns: this.workflowNodeRuns(id),
      approvals: this.workflowApprovals(id),
    };
  }

  latestWorkflowRun(workflowId: string) {
    const row = this.get<{ id: string }>(
      "SELECT id FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1",
      workflowId,
    );
    if (!row) return undefined;
    return this.workflowRun(row.id);
  }

  updateWorkflowRun(id: string, status: string, error: string | null = null) {
    const finished = ["COMPLETED", "FAILED", "CANCELLED", "PARTIAL", "WAITING"].includes(status);
    this.run(
      "UPDATE workflow_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?",
      status,
      error,
      finished ? new Date().toISOString() : null,
      id,
    );
  }

  replaceWorkflowNodeRuns(runId: string, runs: Array<{ nodeId: string; status: string; startedAt: string; finishedAt: string; output: unknown; error: string | null; retryCount: number }>) {
    this.transaction(() => {
      this.run("DELETE FROM workflow_node_runs WHERE run_id = ?", runId);
      for (const run of runs) {
        this.run(
          "INSERT INTO workflow_node_runs (id, run_id, node_id, status, started_at, finished_at, input_json, output_json, error, retry_count) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
          crypto.randomUUID(),
          runId,
          run.nodeId,
          run.status,
          run.startedAt,
          run.finishedAt,
          JSON.stringify(run.output ?? null),
          run.error,
          run.retryCount,
        );
      }
    });
  }

  workflowNodeRuns(runId: string) {
    return this.all<{ node_id: string; status: string; started_at: string | null; finished_at: string | null; output_json: string | null; error: string | null; retry_count: number }>(
      "SELECT node_id, status, started_at, finished_at, output_json, error, retry_count FROM workflow_node_runs WHERE run_id = ?",
      runId,
    ).map((row) => ({
      nodeId: row.node_id,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      output: row.output_json ? JSON.parse(row.output_json) : null,
      error: row.error,
      retryCount: row.retry_count,
    }));
  }

  workflowApprovals(runId: string) {
    return this.all<{ id: string; node_id: string; status: string; decided_at: string | null }>(
      "SELECT id, node_id, status, decided_at FROM workflow_approvals WHERE run_id = ?",
      runId,
    ).map((row) => ({ id: row.id, nodeId: row.node_id, status: row.status, decidedAt: row.decided_at }));
  }

  ensureApproval(runId: string, nodeId: string) {
    const existing = this.get<{ id: string }>("SELECT id FROM workflow_approvals WHERE run_id = ? AND node_id = ?", runId, nodeId);
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    this.run(
      "INSERT INTO workflow_approvals (id, run_id, node_id, status, decided_by, decided_at, created_at) VALUES (?, ?, ?, 'PENDING', NULL, NULL, ?)",
      id,
      runId,
      nodeId,
      new Date().toISOString(),
    );
    return id;
  }

  decideApproval(id: string, status: "APPROVED" | "REJECTED", actorId: string) {
    this.run(
      "UPDATE workflow_approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?",
      status,
      actorId,
      new Date().toISOString(),
      id,
    );
    this.audit(actorId, "workflow.approval", "workflow_approval", id, { status });
  }

  listMissions(workspaceId: string) {
    return this.all<{ id: string; title: string; objective: string; status: string; workflow_id: string | null; dataset_job_id: string | null; updated_at: string }>(
      "SELECT id, title, objective, status, workflow_id, dataset_job_id, updated_at FROM missions WHERE workspace_id = ? ORDER BY updated_at DESC",
      workspaceId,
    ).map((row) => ({
      id: row.id,
      title: row.title,
      objective: row.objective,
      status: row.status,
      workflowId: row.workflow_id,
      datasetJobId: row.dataset_job_id,
      updatedAt: row.updated_at,
    }));
  }

  mission(id: string) {
    const row = this.get<{ id: string; workspace_id: string; title: string; objective: string; plan_json: string; workflow_id: string | null; dataset_job_id: string | null; status: string; updated_at: string }>(
      "SELECT id, workspace_id, title, objective, plan_json, workflow_id, dataset_job_id, status, updated_at FROM missions WHERE id = ?",
      id,
    );
    if (!row) return undefined;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      objective: row.objective,
      plan: JSON.parse(row.plan_json),
      workflowId: row.workflow_id,
      datasetJobId: row.dataset_job_id,
      status: row.status,
      updatedAt: row.updated_at,
    };
  }

  createMission(input: { workspaceId: string; title: string; objective: string; plan: unknown; workflowId: string | null; datasetJobId: string | null; actorId: string }) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.run(
      "INSERT INTO missions (id, workspace_id, title, objective, plan_json, workflow_id, dataset_job_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PLANNED', ?, ?)",
      id,
      input.workspaceId,
      input.title,
      input.objective,
      JSON.stringify(input.plan),
      input.workflowId,
      input.datasetJobId,
      now,
      now,
    );
    this.audit(input.actorId, "mission.created", "mission", id, { title: input.title });
    return this.mission(id)!;
  }

  connectorPowered(workspaceId: string, provider = "email") {
    const row = this.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_connectors WHERE workspace_id = ? AND provider = ?", workspaceId, provider);
    return Number(row?.n ?? 0) > 0;
  }

  saveConnectorKey(input: { workspaceId: string; provider: string; secret: string; actorId: string }) {
    const now = new Date().toISOString();
    if (!input.secret) {
      this.run("DELETE FROM agent_connectors WHERE workspace_id = ? AND provider = ?", input.workspaceId, input.provider);
    } else {
      this.run(
        `INSERT INTO agent_connectors (workspace_id, provider, secret, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, provider) DO UPDATE SET secret = excluded.secret, updated_at = excluded.updated_at`,
        input.workspaceId,
        input.provider,
        input.secret,
        now,
      );
    }
    this.audit(input.actorId, "connector.powered", "workspace", input.workspaceId, { provider: input.provider, powered: Boolean(input.secret) });
    return this.connectorPowered(input.workspaceId, input.provider);
  }

  workflowRunCounts(workspaceId: string) {
    const rows = this.all<{ status: string; n: number }>(
      "SELECT status, COUNT(*) AS n FROM workflow_runs WHERE workspace_id = ? GROUP BY status",
      workspaceId,
    );
    return {
      completed: rows.filter((row) => row.status === "COMPLETED").reduce((sum, row) => sum + Number(row.n), 0),
      failed: rows.filter((row) => row.status === "FAILED" || row.status === "PARTIAL").reduce((sum, row) => sum + Number(row.n), 0),
    };
  }

  // ---------------------------------------------------------------------------
  // Gauntlet Hackathon Tracker: War-Room cockpit for solo and team hackers.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Gauntlet Squad War-Rooms & Solo Cockpits
  // ---------------------------------------------------------------------------

  listGauntletRooms(userId: string, workspaceId?: string): GauntletRoom[] {
    this.ensurePersonalSoloRoom(userId, workspaceId);

    const rows = this.all<GauntletRoomRow>(
      `SELECT r.*
       FROM gauntlet_rooms r
       WHERE r.owner_id = ? 
          OR r.members_json LIKE ?
          OR (? IS NOT NULL AND r.workspace_id = ?)
       ORDER BY (r.type = 'solo') DESC, r.updated_at DESC`,
      userId,
      `%"userId":"${userId}"%`,
      workspaceId ?? null,
      workspaceId ?? null,
    );

    return rows.map((r) => this.mapGauntletRoom(r));
  }

  ensurePersonalSoloRoom(userId: string, workspaceId?: string): GauntletRoom {
    const existing = this.get<GauntletRoomRow>(
      "SELECT * FROM gauntlet_rooms WHERE owner_id = ? AND type = 'solo' LIMIT 1",
      userId,
    );
    if (existing) return this.mapGauntletRoom(existing);

    const id = crypto.randomUUID();
    const code = `SOLO-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const now = new Date().toISOString();
    const members = JSON.stringify([
      { userId, name: "Solo Hacker", role: "Solo Lead", joinedAt: now },
    ]);

    this.run(
      `INSERT INTO gauntlet_rooms (id, code, name, type, description, owner_id, workspace_id, members_json, created_at, updated_at)
       VALUES (?, ?, 'Personal Solo Cockpit', 'solo', 'Private high-velocity focus room for your personal hackathon chases.', ?, ?, ?, ?, ?)`,
      id,
      code,
      userId,
      workspaceId ?? null,
      members,
      now,
      now,
    );

    const created = this.get<GauntletRoomRow>("SELECT * FROM gauntlet_rooms WHERE id = ?", id);
    return this.mapGauntletRoom(created!);
  }

  getGauntletRoom(idOrCode: string): GauntletRoom | null {
    const clean = idOrCode.trim();
    const row = this.get<GauntletRoomRow>(
      "SELECT * FROM gauntlet_rooms WHERE id = ? OR LOWER(code) = LOWER(?)",
      clean,
      clean,
    );
    if (!row) return null;
    return this.mapGauntletRoom(row);
  }

  createGauntletRoom(input: {
    name: string;
    type?: "solo" | "squad";
    description?: string | null;
    ownerId: string;
    workspaceId?: string | null;
    ownerName: string;
    ownerRole?: string;
  }): GauntletRoom {
    const id = crypto.randomUUID();
    const prefix = input.type === "solo" ? "SOLO" : "SQUAD";
    const code = `${prefix}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const now = new Date().toISOString();
    const members = [
      {
        userId: input.ownerId,
        name: input.ownerName || "Squad Captain",
        role: input.ownerRole || "Squad Captain / Lead",
        joinedAt: now,
      },
    ];

    this.run(
      `INSERT INTO gauntlet_rooms (id, code, name, type, description, owner_id, workspace_id, members_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      code,
      input.name.trim(),
      input.type || "squad",
      input.description?.trim() || null,
      input.ownerId,
      input.workspaceId ?? null,
      JSON.stringify(members),
      now,
      now,
    );

    const row = this.get<GauntletRoomRow>("SELECT * FROM gauntlet_rooms WHERE id = ?", id);
    return this.mapGauntletRoom(row!);
  }

  joinGauntletRoom(
    code: string,
    user: { id: string; name: string; role?: string; email?: string },
  ): GauntletRoom | null {
    const room = this.getGauntletRoom(code);
    if (!room) return null;

    const members = [...room.members];
    const existingIndex = members.findIndex(
      (m) => (m.userId && m.userId === user.id) || (m.name.toLowerCase() === user.name.toLowerCase()),
    );

    const now = new Date().toISOString();
    if (existingIndex >= 0) {
      members[existingIndex] = {
        ...members[existingIndex]!,
        userId: user.id,
        role: user.role || members[existingIndex]!.role,
      };
    } else {
      members.push({
        userId: user.id,
        name: user.name || "Teammate",
        role: user.role || "Developer",
        email: user.email,
        joinedAt: now,
      });
    }

    this.run(
      "UPDATE gauntlet_rooms SET members_json = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(members),
      now,
      room.id,
    );

    return this.getGauntletRoom(room.id);
  }

  deleteGauntletRoom(roomId: string, userId: string): boolean {
    const room = this.get<GauntletRoomRow>("SELECT * FROM gauntlet_rooms WHERE id = ?", roomId);
    if (!room || room.owner_id !== userId) return false;

    const hackathons = this.all<{ id: string }>("SELECT id FROM gauntlet_hackathons WHERE room_id = ?", roomId);
    for (const h of hackathons) {
      this.run("DELETE FROM gauntlet_updates WHERE hackathon_id = ?", h.id);
    }
    this.run("DELETE FROM gauntlet_hackathons WHERE room_id = ?", roomId);
    this.run("DELETE FROM gauntlet_rooms WHERE id = ?", roomId);
    return true;
  }

  updateGauntletRoom(
    roomId: string,
    userId: string,
    input: { name?: string; description?: string | null; type?: "solo" | "squad" },
  ): GauntletRoom | null {
    const room = this.get<GauntletRoomRow>("SELECT * FROM gauntlet_rooms WHERE id = ?", roomId);
    if (!room || room.owner_id !== userId) return null;

    const name = input.name !== undefined ? input.name.trim() : room.name;
    const description =
      input.description !== undefined
        ? input.description ? input.description.trim() : null
        : room.description;
    const type = input.type !== undefined ? input.type : room.type;
    const now = new Date().toISOString();

    this.run(
      "UPDATE gauntlet_rooms SET name = ?, description = ?, type = ?, updated_at = ? WHERE id = ?",
      name,
      description,
      type,
      now,
      roomId,
    );

    return this.getGauntletRoom(roomId);
  }

  private mapGauntletRoom(row: GauntletRoomRow): GauntletRoom {
    let members: GauntletMember[] = [];
    try {
      members = JSON.parse(row.members_json ?? "[]");
    } catch {
      members = [];
    }

    const hackathonRows = this.all<{ id: string; checklist_json: string }>(
      "SELECT id, checklist_json FROM gauntlet_hackathons WHERE room_id = ?",
      row.id,
    );

    let completedTasksCount = 0;
    let totalTasksCount = 0;
    for (const h of hackathonRows) {
      try {
        const items = JSON.parse(h.checklist_json || "[]") as GauntletChecklistItem[];
        totalTasksCount += items.length;
        completedTasksCount += items.filter((item) => item.done).length;
      } catch {}
    }

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: (row.type === "solo" ? "solo" : "squad") as "solo" | "squad",
      description: row.description,
      ownerId: row.owner_id,
      workspaceId: row.workspace_id,
      members,
      hackathonsCount: hackathonRows.length,
      completedTasksCount,
      totalTasksCount,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Hackathon Cards & Follow-Ups
  // ---------------------------------------------------------------------------

  listGauntletHackathons(userId: string, roomId?: string | null, workspaceId?: string): GauntletHackathon[] {
    let query = `
      SELECT h.*,
        (SELECT COUNT(*) FROM gauntlet_updates u WHERE u.hackathon_id = h.id) AS updates_count,
        (SELECT body FROM gauntlet_updates u WHERE u.hackathon_id = h.id ORDER BY u.created_at DESC LIMIT 1) AS latest_body,
        (SELECT badge FROM gauntlet_updates u WHERE u.hackathon_id = h.id ORDER BY u.created_at DESC LIMIT 1) AS latest_badge,
        (SELECT author_name FROM gauntlet_updates u WHERE u.hackathon_id = h.id ORDER BY u.created_at DESC LIMIT 1) AS latest_author,
        (SELECT created_at FROM gauntlet_updates u WHERE u.hackathon_id = h.id ORDER BY u.created_at DESC LIMIT 1) AS latest_created_at
       FROM gauntlet_hackathons h
    `;
    const params: any[] = [];

    if (roomId) {
      query += ` WHERE h.room_id = ? ORDER BY h.updated_at DESC`;
      params.push(roomId);
    } else {
      query += ` WHERE (h.user_id = ? OR (? IS NOT NULL AND h.workspace_id = ?)) ORDER BY h.updated_at DESC`;
      params.push(userId, workspaceId ?? null, workspaceId ?? null);
    }

    const rows = this.all<GauntletHackathonRow & {
      updates_count: number;
      latest_body: string | null;
      latest_badge: string | null;
      latest_author: string | null;
      latest_created_at: string | null;
    }>(query, ...params);

    return rows.map((r) => mapGauntletHackathon(r));
  }

  getGauntletHackathon(id: string, userId: string): (GauntletHackathon & { updates: GauntletUpdate[] }) | null {
    const row = this.get<GauntletHackathonRow>(
      "SELECT * FROM gauntlet_hackathons WHERE id = ? AND (user_id = ? OR room_id IN (SELECT id FROM gauntlet_rooms))",
      id,
      userId,
    );
    if (!row) return null;
    const updates = this.listGauntletUpdates(id);
    return {
      ...mapGauntletHackathon(row),
      updates,
    };
  }

  createGauntletHackathon(
    userId: string,
    input: {
      workspaceId?: string | null;
      roomId?: string | null;
      name: string;
      phase?: string;
      targetDate?: string | null;
      submitDeadline?: string | null;
      roundDate?: string | null;
      prizePool?: string | null;
      organizer?: string | null;
      registrar?: string | null;
      track?: string | null;
      link?: string | null;
      repoUrl?: string | null;
      deckUrl?: string | null;
      demoUrl?: string | null;
      submissionUrl?: string | null;
      registrantsCount?: number;
      registrantsAsOf?: string | null;
      teammates?: Array<{ name: string; role: string; email?: string }>;
      checklist?: GauntletChecklistItem[];
      tags?: string[];
      notes?: string | null;
    },
  ): GauntletHackathon {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const phase = input.phase ?? "targeting";

    // Auto-populate default follow-up checklist if none provided
    const checklist = input.checklist && input.checklist.length > 0 ? input.checklist : defaultGauntletChecklist(input);

    this.run(
      `INSERT INTO gauntlet_hackathons (
        id, user_id, workspace_id, room_id, name, phase, target_date, submit_deadline, round_date,
        prize_pool, organizer, registrar, track, link, repo_url, deck_url, demo_url,
        submission_url, registrants_count, registrants_as_of, teammates_json, checklist_json, tags_json, notes, results,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
      id,
      userId,
      input.workspaceId ?? null,
      input.roomId ?? null,
      input.name,
      phase,
      input.targetDate ?? null,
      input.submitDeadline ?? null,
      input.roundDate ?? null,
      input.prizePool ?? null,
      input.organizer ?? null,
      input.registrar ?? null,
      input.track ?? null,
      input.link ?? null,
      input.repoUrl ?? null,
      input.deckUrl ?? null,
      input.demoUrl ?? null,
      input.submissionUrl ?? null,
      input.registrantsCount ?? 0,
      input.registrantsAsOf ?? now,
      JSON.stringify(input.teammates ?? []),
      JSON.stringify(checklist),
      JSON.stringify(input.tags ?? []),
      input.notes ?? null,
      now,
      now,
    );
    const item = this.getGauntletHackathon(id, userId);
    return item!;
  }

  updateGauntletHackathon(
    id: string,
    userId: string,
    patch: Partial<{
      roomId: string | null;
      name: string;
      phase: string;
      targetDate: string | null;
      submitDeadline: string | null;
      roundDate: string | null;
      prizePool: string | null;
      organizer: string | null;
      registrar: string | null;
      track: string | null;
      link: string | null;
      repoUrl: string | null;
      deckUrl: string | null;
      demoUrl: string | null;
      submissionUrl: string | null;
      registrantsCount: number;
      registrantsAsOf: string | null;
      teammates: Array<{ name: string; role: string; email?: string }>;
      checklist: GauntletChecklistItem[];
      tags: string[];
      notes: string | null;
      results: string | null;
    }>,
  ): GauntletHackathon | null {
    const existing = this.getGauntletHackathon(id, userId);
    if (!existing) return null;
    const now = new Date().toISOString();

    const roomId = patch.roomId !== undefined ? patch.roomId : existing.roomId;
    const name = patch.name !== undefined ? patch.name : existing.name;
    const phase = patch.phase !== undefined ? patch.phase : existing.phase;
    const targetDate = patch.targetDate !== undefined ? patch.targetDate : existing.targetDate;
    const submitDeadline = patch.submitDeadline !== undefined ? patch.submitDeadline : existing.submitDeadline;
    const roundDate = patch.roundDate !== undefined ? patch.roundDate : existing.roundDate;
    const prizePool = patch.prizePool !== undefined ? patch.prizePool : existing.prizePool;
    const organizer = patch.organizer !== undefined ? patch.organizer : existing.organizer;
    const registrar = patch.registrar !== undefined ? patch.registrar : existing.registrar;
    const track = patch.track !== undefined ? patch.track : existing.track;
    const link = patch.link !== undefined ? patch.link : existing.link;
    const repoUrl = patch.repoUrl !== undefined ? patch.repoUrl : existing.repoUrl;
    const deckUrl = patch.deckUrl !== undefined ? patch.deckUrl : existing.deckUrl;
    const demoUrl = patch.demoUrl !== undefined ? patch.demoUrl : existing.demoUrl;
    const submissionUrl = patch.submissionUrl !== undefined ? patch.submissionUrl : existing.submissionUrl;
    const registrantsCount = patch.registrantsCount !== undefined ? patch.registrantsCount : existing.registrantsCount;
    const registrantsAsOf = patch.registrantsAsOf !== undefined ? patch.registrantsAsOf : existing.registrantsAsOf;
    const teammatesJson = patch.teammates !== undefined ? JSON.stringify(patch.teammates) : JSON.stringify(existing.teammates);
    const checklistJson = patch.checklist !== undefined ? JSON.stringify(patch.checklist) : JSON.stringify(existing.checklist);
    const tagsJson = patch.tags !== undefined ? JSON.stringify(patch.tags) : JSON.stringify(existing.tags);
    const notes = patch.notes !== undefined ? patch.notes : existing.notes;
    const results = patch.results !== undefined ? patch.results : existing.results;

    this.run(
      `UPDATE gauntlet_hackathons SET
        room_id = ?,
        name = ?,
        phase = ?,
        target_date = ?,
        submit_deadline = ?,
        round_date = ?,
        prize_pool = ?,
        organizer = ?,
        registrar = ?,
        track = ?,
        link = ?,
        repo_url = ?,
        deck_url = ?,
        demo_url = ?,
        submission_url = ?,
        registrants_count = ?,
        registrants_as_of = ?,
        teammates_json = ?,
        checklist_json = ?,
        tags_json = ?,
        notes = ?,
        results = ?,
        updated_at = ?
       WHERE id = ?`,
      roomId,
      name,
      phase,
      targetDate,
      submitDeadline,
      roundDate,
      prizePool,
      organizer,
      registrar,
      track,
      link,
      repoUrl,
      deckUrl,
      demoUrl,
      submissionUrl,
      registrantsCount,
      registrantsAsOf,
      teammatesJson,
      checklistJson,
      tagsJson,
      notes,
      results,
      now,
      id,
    );
    return this.getGauntletHackathon(id, userId);
  }

  updateGauntletChecklist(hackathonId: string, checklist: GauntletChecklistItem[]): GauntletHackathon | null {
    const existing = this.get<GauntletHackathonRow>("SELECT * FROM gauntlet_hackathons WHERE id = ?", hackathonId);
    if (!existing) return null;
    const now = new Date().toISOString();
    this.run(
      "UPDATE gauntlet_hackathons SET checklist_json = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(checklist),
      now,
      hackathonId,
    );
    const updated = this.get<GauntletHackathonRow>("SELECT * FROM gauntlet_hackathons WHERE id = ?", hackathonId);
    return mapGauntletHackathon(updated!);
  }

  deleteGauntletHackathon(id: string, userId: string): boolean {
    this.run("DELETE FROM gauntlet_updates WHERE hackathon_id = ?", id);
    this.run("DELETE FROM gauntlet_hackathons WHERE id = ?", id);
    return true;
  }

  addGauntletUpdate(
    hackathonId: string,
    userId: string,
    authorName: string,
    body: string,
    badge: string = "update",
  ): GauntletUpdate | null {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.run(
      "INSERT INTO gauntlet_updates (id, hackathon_id, user_id, author_name, body, badge, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      hackathonId,
      userId,
      authorName,
      body,
      badge,
      now,
    );
    this.run("UPDATE gauntlet_hackathons SET updated_at = ? WHERE id = ?", now, hackathonId);
    return {
      id,
      hackathonId,
      userId,
      authorName,
      body,
      badge: (["update", "blocker", "milestone", "submission"].includes(badge) ? badge : "update") as any,
      createdAt: now,
    };
  }

  listGauntletUpdates(hackathonId: string): GauntletUpdate[] {
    const rows = this.all<GauntletUpdateRow>(
      "SELECT * FROM gauntlet_updates WHERE hackathon_id = ? ORDER BY created_at DESC",
      hackathonId,
    );
    return rows.map((r) => ({
      id: r.id,
      hackathonId: r.hackathon_id,
      userId: r.user_id,
      authorName: r.author_name,
      body: r.body,
      badge: (["update", "blocker", "milestone", "submission"].includes(r.badge) ? r.badge : "update") as any,
      createdAt: r.created_at,
    }));
  }

  listAvailableEventHackathons(workspaceId: string, userId: string) {
    const jobs = this.all<{ id: string; name: string }>(
      "SELECT id, name FROM jobs WHERE workspace_id = ? AND intent = 'EVENT_LOOKUP' AND archived = 0 ORDER BY updated_at DESC",
      workspaceId,
    );
    const userEvents = this.listEvents(userId);
    const jobToEventMap = new Map<string, string>();
    for (const ev of userEvents) {
      for (const [, jId] of Object.entries(ev.jobs)) {
        jobToEventMap.set(jId, ev.name);
      }
    }

    const results: Array<{
      name: string;
      organizer: string;
      dates: string;
      prizePool: string;
      website: string;
      track: string;
      jobId: string;
      searchName: string;
      mainPanelEvent: string | null;
    }> = [];
    const seenNames = new Set<string>();

    for (const job of jobs) {
      const version = this.latestVersion(job.id);
      if (!version) continue;
      const records = this.recordsForVersion(version.id);
      const mainPanelEvent = jobToEventMap.get(job.id) || null;

      for (const rec of records) {
        const f = rec.fields;
        const name = (f.event_name || f.company_name || rec.canonicalEntityId || "").trim();
        if (!name || seenNames.has(name.toLowerCase())) continue;
        seenNames.add(name.toLowerCase());
        results.push({
          name,
          organizer: f.organizer || "Community Host",
          dates: f.dates || "",
          prizePool: f.prize_pool || "",
          website: f.website || rec.sources[0]?.url || "",
          track: f.description || "",
          jobId: job.id,
          searchName: job.name,
          mainPanelEvent,
        });
      }
    }
    return results;
  }
}

interface JobRow {
  id: string;
  workspace_id: string;
  name: string;
  intent: string;
  status: string;
  query: string;
  blueprint_json: string;
  schedule_json: string | null;
  demo: number;
  archived: number;
  created_at: string;
  updated_at: string;
  version_number?: number | null;
  version_id?: string | null;
  row_count?: number | null;
  source_count?: number | null;
  quality_score?: number | null;
  avg_confidence?: number | null;
  last_run_at?: string | null;
  pending_conflicts?: number | null;
  diff_json?: string | null;
}

interface EventRow {
  id: string;
  name: string;
  description: string;
  date: string;
  targets: string;
  favourite: number;
  archived: number;
  folder_names_json: string;
  jobs_json: string;
  hidden_folders_json: string | null;
  opened_at: string;
}

function mapEvent(row: EventRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    date: row.date,
    targets: row.targets,
    favourite: Boolean(row.favourite),
    archived: Boolean(row.archived),
    folderNames: JSON.parse(row.folder_names_json) as Record<string, string>,
    jobs: JSON.parse(row.jobs_json) as Record<string, string>,
    hiddenFolders: JSON.parse(row.hidden_folders_json ?? "[]") as string[],
    openedAt: row.opened_at,
  };
}

interface VersionRow {
  version_number: number | null;
  version_id: string | null;
  row_count: number | null;
  source_count: number | null;
  quality_score: number | null;
  avg_confidence: number | null;
  last_run_at: string | null;
  pending_conflicts: number | null;
  diff_json: string | null;
}

interface Version {
  id: string;
  run_id: string;
  version_number: number;
  created_at: string;
  row_count: number;
  source_count: number;
  status: string;
  quality_score: number | null;
  avg_confidence: number | null;
}

interface RecordRow {
  id: string;
  job_id: string;
  dataset_version_id: string;
  canonical_entity_id: string;
  fields_json: string;
  rank: number;
  activity_score: number;
  activity_components_json: string;
  confidence: number;
  confidence_components_json: string;
  status: string;
  validation_json: string;
  source_count: number;
  content_hash: string;
  flags_json: string;
  alternates_json: string;
  sources_json: string;
  annotation_json: string;
  contactability_json: string | null;
  trust_json: string | null;
}

interface EvidenceRow {
  id: string;
  field_name: string;
  value: string;
  source_url: string;
  source_title: string;
  excerpt: string;
  collected_at: string;
  published_at: string | null;
  authority: string | null;
  confidence: number;
}

interface RunRow {
  id: string;
  run_number: number;
  progress_json: string | null;
  error: string | null;
}

export interface Progress {
  stage: string;
  percent: number;
  sourcesPlanned: number;
  sourcesScanned: number;
  documents: number;
  records: number;
  valid: number;
  duplicates: number;
  conflicts: number;
}

export function emptyProgress(stage: string): Progress {
  return {
    stage,
    percent: stage === "COMPLETED" || stage === "CONFLICT_REVIEW" ? 100 : 8,
    sourcesPlanned: 0,
    sourcesScanned: 0,
    documents: 0,
    records: 0,
    valid: 0,
    duplicates: 0,
    conflicts: 0,
  };
}

function mapJob(row: JobRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    intent: row.intent,
    status: row.status as JobState,
    query: row.query,
    blueprint: JSON.parse(row.blueprint_json) as CollectionBlueprint,
    schedule: row.schedule_json ? (JSON.parse(row.schedule_json) as Schedule) : null,
    demo: Boolean(row.demo),
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvidence(row: EvidenceRow) {
  return {
    id: row.id,
    fieldName: row.field_name,
    value: row.value,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    excerpt: row.excerpt,
    collectedAt: row.collected_at,
    publishedAt: row.published_at ?? "",
    authority: (row.authority ?? "secondary") as "official" | "secondary" | "press",
    confidence: row.confidence,
  };
}

function mapConflict(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    jobName: row.job_name ? String(row.job_name) : undefined,
    runId: String(row.run_id),
    recordId: row.record_id ? String(row.record_id) : null,
    canonicalEntityId: String(row.canonical_entity_id),
    label: labelFromFields(row.fields_json),
    field: String(row.field),
    oldValue: String(row.old_value),
    newValue: String(row.new_value),
    oldEvidence: row.old_evidence_json ? JSON.parse(String(row.old_evidence_json)) : null,
    newEvidence: row.new_evidence_json ? JSON.parse(String(row.new_evidence_json)) : null,
    detectedAt: String(row.detected_at),
    status: String(row.status),
    decision: row.decision ? String(row.decision) : null,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    reason: row.reason ? String(row.reason) : null,
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    resolvedBy: row.resolved_by ? String(row.resolved_by) : null,
  };
}

function summarizeDiff(json: string | null | undefined) {
  if (!json) return null;
  const diff = JSON.parse(json) as {
    firstVersion?: boolean;
    added?: unknown[];
    removed?: unknown[];
    changed?: unknown[];
    unchanged?: unknown[];
    conflictIds?: unknown[];
  };
  return {
    firstVersion: Boolean(diff.firstVersion),
    added: diff.added?.length ?? 0,
    removed: diff.removed?.length ?? 0,
    changed: diff.changed?.length ?? 0,
    unchanged: diff.unchanged?.length ?? 0,
    conflicts: diff.conflictIds?.length ?? 0,
  };
}

export function labelFromFields(json: unknown) {
  if (!json || typeof json !== "string") return undefined;
  try {
    return labelOf(JSON.parse(json) as Record<string, string>);
  } catch {
    return undefined;
  }
}

export function labelOf(fields: Record<string, string>) {
  const f = fields;
  if (f.paper_title) return f.paper_title;
  if (f.person_name) return f.person_name;
  if (f.role_title) return f.company_name ? `${f.role_title} — ${f.company_name}` : f.role_title;
  return f.company_name || f.event_name || f.program_name || f.product_name || f.segment || "Record";
}

export interface GauntletMember {
  userId?: string;
  name: string;
  role: string;
  email?: string;
  joinedAt: string;
}

export interface GauntletRoomRow {
  id: string;
  code: string;
  name: string;
  type: string;
  description: string | null;
  owner_id: string;
  workspace_id: string | null;
  members_json: string;
  created_at: string;
  updated_at: string;
}

export interface GauntletRoom {
  id: string;
  code: string;
  name: string;
  type: "solo" | "squad";
  description: string | null;
  ownerId: string;
  workspaceId: string | null;
  members: GauntletMember[];
  hackathonsCount: number;
  completedTasksCount: number;
  totalTasksCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GauntletChecklistItem {
  id: string;
  text: string;
  title?: string;
  done: boolean;
  completed?: boolean;
  assignee?: string;
  assignedTo?: string;
  completedAt?: string | null;
  mandatory?: boolean;
}

export function defaultGauntletChecklist(hackathon: { link?: string | null; track?: string | null; deckUrl?: string | null; repoUrl?: string | null; demoUrl?: string | null; submissionUrl?: string | null }): GauntletChecklistItem[] {
  return [
    {
      id: "reg",
      text: "Register team or solo entry on event portal",
      title: "Register team or solo entry on event portal",
      done: Boolean(hackathon.link?.trim()),
      completed: Boolean(hackathon.link?.trim()),
      mandatory: true,
    },
    {
      id: "track",
      text: "Select official problem statement and challenge track",
      title: "Select official problem statement and challenge track",
      done: Boolean(hackathon.track?.trim()),
      completed: Boolean(hackathon.track?.trim()),
      mandatory: true,
    },
    {
      id: "deck",
      text: "Draft and finalize Slide Deck / Pitch PPT",
      title: "Draft and finalize Slide Deck / Pitch PPT",
      done: Boolean(hackathon.deckUrl?.trim()),
      completed: Boolean(hackathon.deckUrl?.trim()),
      mandatory: true,
    },
    {
      id: "repo",
      text: "Initialize GitHub repository and push MVP code",
      title: "Initialize GitHub repository and push MVP code",
      done: Boolean(hackathon.repoUrl?.trim()),
      completed: Boolean(hackathon.repoUrl?.trim()),
      mandatory: true,
    },
    {
      id: "demo",
      text: "Record & verify 2-minute demo video (Loom/YouTube)",
      title: "Record & verify 2-minute demo video (Loom/YouTube)",
      done: Boolean(hackathon.demoUrl?.trim()),
      completed: Boolean(hackathon.demoUrl?.trim()),
      mandatory: true,
    },
    {
      id: "submit",
      text: "Pre-flight verification & submit project on portal before deadline",
      title: "Pre-flight verification & submit project on portal before deadline",
      done: Boolean(hackathon.submissionUrl?.trim()),
      completed: Boolean(hackathon.submissionUrl?.trim()),
      mandatory: true,
    },
  ];
}

export interface GauntletHackathonRow {
  id: string;
  user_id: string;
  workspace_id: string | null;
  room_id: string | null;
  name: string;
  phase: string;
  target_date: string | null;
  submit_deadline: string | null;
  round_date: string | null;
  prize_pool: string | null;
  organizer: string | null;
  registrar: string | null;
  track: string | null;
  link: string | null;
  repo_url: string | null;
  deck_url: string | null;
  demo_url: string | null;
  submission_url: string | null;
  registrants_count: number;
  registrants_as_of: string | null;
  teammates_json: string;
  checklist_json: string;
  tags_json: string;
  notes: string | null;
  results: string | null;
  created_at: string;
  updated_at: string;
}

export interface GauntletUpdateRow {
  id: string;
  hackathon_id: string;
  user_id: string;
  author_name: string;
  body: string;
  badge: string;
  created_at: string;
}

export interface GauntletHackathon {
  id: string;
  userId: string;
  workspaceId: string | null;
  roomId: string | null;
  name: string;
  phase: "targeting" | "ideation" | "hacking" | "demo" | "won";
  targetDate: string | null;
  submitDeadline: string | null;
  roundDate: string | null;
  prizePool: string | null;
  organizer: string | null;
  registrar: string | null;
  track: string | null;
  link: string | null;
  repoUrl: string | null;
  deckUrl: string | null;
  demoUrl: string | null;
  submissionUrl: string | null;
  registrantsCount: number;
  registrantsAsOf: string | null;
  teammates: Array<{ name: string; role: string; email?: string }>;
  checklist: GauntletChecklistItem[];
  tags: string[];
  notes: string | null;
  results: string | null;
  createdAt: string;
  updatedAt: string;
  updatesCount?: number;
  latestUpdate?: GauntletUpdate | null;
  readinessScore?: number;
}

export interface GauntletUpdate {
  id: string;
  hackathonId: string;
  userId: string;
  authorName: string;
  body: string;
  badge: "update" | "blocker" | "milestone" | "submission";
  createdAt: string;
}

function mapGauntletHackathon(row: GauntletHackathonRow & {
  updates_count?: number;
  latest_body?: string | null;
  latest_badge?: string | null;
  latest_author?: string | null;
  latest_created_at?: string | null;
}): GauntletHackathon {
  let teammates: Array<{ name: string; role: string; email?: string }> = [];
  try {
    teammates = JSON.parse(row.teammates_json ?? "[]");
  } catch {
    teammates = [];
  }

  let checklist: GauntletChecklistItem[] = [];
  try {
    checklist = JSON.parse(row.checklist_json ?? "[]");
  } catch {
    checklist = [];
  }

  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags_json ?? "[]");
  } catch {
    tags = [];
  }

  // Calculate readiness score from checklist or deliverables
  let score = 0;
  if (checklist.length > 0) {
    const doneCount = checklist.filter((item) => item.done).length;
    score = Math.round((doneCount / checklist.length) * 100);
  } else {
    if (row.name?.trim()) score += 15;
    if (row.track?.trim() || row.organizer?.trim()) score += 15;
    if (row.deck_url?.trim()) score += 20;
    if (row.repo_url?.trim()) score += 20;
    if (row.demo_url?.trim()) score += 20;
    if (row.submission_url?.trim()) score += 10;
  }

  const latestUpdate = row.latest_body
    ? {
        id: "",
        hackathonId: row.id,
        userId: row.user_id,
        authorName: row.latest_author ?? "Teammate",
        body: row.latest_body,
        badge: ((["update", "blocker", "milestone", "submission"].includes(row.latest_badge ?? "")
          ? row.latest_badge
          : "update") as "update" | "blocker" | "milestone" | "submission"),
        createdAt: row.latest_created_at ?? row.updated_at,
      }
    : null;

  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    roomId: row.room_id,
    name: row.name,
    phase: ((["targeting", "ideation", "hacking", "demo", "won"].includes(row.phase)
      ? row.phase
      : "targeting") as "targeting" | "ideation" | "hacking" | "demo" | "won"),
    targetDate: row.target_date,
    submitDeadline: row.submit_deadline,
    roundDate: row.round_date,
    prizePool: row.prize_pool,
    organizer: row.organizer,
    registrar: row.registrar,
    track: row.track,
    link: row.link,
    repoUrl: row.repo_url,
    deckUrl: row.deck_url,
    demoUrl: row.demo_url,
    submissionUrl: row.submission_url,
    registrantsCount: row.registrants_count ?? 0,
    registrantsAsOf: row.registrants_as_of,
    teammates,
    checklist,
    tags,
    notes: row.notes,
    results: row.results,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatesCount: row.updates_count ?? 0,
    latestUpdate,
    readinessScore: Math.min(100, Math.max(0, score)),
  };
}


