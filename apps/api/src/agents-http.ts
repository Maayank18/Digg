import {
  buildLensReport,
  missionStarters,
  missionWorkflow,
  planMission,
  simulateMission,
  validateGraph,
  workflowTemplates,
  type AgentRecord,
  type PublishedRecord,
  type WorkflowGraph,
} from "@dig/core";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requestWorkflowCancel, startWorkflowRun, subscribeWorkflow } from "./agent-runner.js";
import type { DigDb } from "./db.js";

const graphSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    kind: z.string(),
    label: z.string(),
    position: z.object({ x: z.number(), y: z.number() }),
    config: z.object({ kind: z.string() }).passthrough(),
    retry: z.number().optional(),
  })),
  edges: z.array(z.object({ id: z.string(), source: z.string(), target: z.string(), sourceHandle: z.enum(["out", "yes", "no", "down"]).optional() })),
});

function bindDataset(graph: WorkflowGraph, job: { id: string; name: string } | undefined): WorkflowGraph {
  if (!job) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const kind = node.config.kind;
      if (kind !== "dataset" && kind !== "research" && kind !== "search" && kind !== "rerun" && kind !== "compare") return node;
      return { ...node, label: job.name, config: { ...node.config, jobId: job.id } };
    }),
  };
}

function toAgentRecord(record: PublishedRecord): AgentRecord {
  const hasPath = Boolean(
    record.contactability?.score ||
    record.fields.email ||
    record.fields.phone ||
    record.fields.linkedin ||
    record.fields.github ||
    record.fields.website ||
    record.fields.domain ||
    record.fields.apply_url ||
    record.fields.url
  );
  return {
    canonicalEntityId: record.canonicalEntityId,
    label:
      record.fields.company_name ||
      record.fields.person_name ||
      record.fields.organization ||
      record.fields.vendor ||
      record.fields.name ||
      record.canonicalEntityId,
    fields: record.fields,
    status: record.status,
    confidence: record.confidence,
    contactabilityScore: record.contactability ? Math.round(record.contactability.score * 100) : hasPath ? 75 : 0,
    contactabilityStatus: record.contactability?.status ?? (hasPath ? "PARTIAL" : "NONE"),
    trustScore: record.trust ? Math.round(record.trust.overallTrust * 100) : 0,
    trustStatus: record.trust?.status ?? "",
    change: "unchanged",
    sourceCount: record.sourceCount,
  };
}

export function mountAgents(
  app: Express,
  db: DigDb,
  http: {
    ok: (res: Response, req: Request, data?: unknown) => void;
    fail: (res: Response, req: Request, status: number, code: string, message: string) => void;
    authOf: (req: Request) => { user: { id: string; name?: string; email?: string; role?: string }; workspace: { id: string; name?: string } };
  },
) {
  const { ok, fail, authOf } = http;

  const ownWorkflow = (req: Request, res: Response) => {
    const workflow = db.workflow(req.params.id);
    if (!workflow || workflow.workspaceId !== authOf(req).workspace.id) {
      fail(res, req, 404, "NOT_FOUND", "That workflow doesn’t exist or isn’t yours.");
      return undefined;
    }
    return workflow;
  };

  app.get("/api/agents/power", (req, res) => {
    ok(res, req, {
      email: db.connectorPowered(authOf(req).workspace.id, "email"),
      whatsapp: db.connectorPowered(authOf(req).workspace.id, "whatsapp"),
      linkedin: db.connectorPowered(authOf(req).workspace.id, "linkedin"),
    });
  });

  app.put("/api/agents/power", (req, res) => {
    const body = z.object({
      provider: z.enum(["email", "whatsapp", "linkedin"]).default("email"),
      apiKey: z.string().max(4000),
    }).parse(req.body ?? {});
    const apiKey = body.apiKey.trim();
    if (apiKey && apiKey.length < 4) return fail(res, req, 400, "INVALID", "Use a valid key or credentials, or leave it blank to clear.");
    const connected = db.saveConnectorKey({ workspaceId: authOf(req).workspace.id, provider: body.provider, secret: apiKey, actorId: authOf(req).user.id });
    ok(res, req, {
      provider: body.provider,
      connected,
      email: db.connectorPowered(authOf(req).workspace.id, "email"),
      whatsapp: db.connectorPowered(authOf(req).workspace.id, "whatsapp"),
      linkedin: db.connectorPowered(authOf(req).workspace.id, "linkedin"),
    });
  });

  app.get("/api/agents/templates", (req, res) => {
    ok(res, req, { workflows: workflowTemplates().map(({ graph: _graph, ...item }) => item), missions: missionStarters() });
  });

  app.get("/api/workflows", (req, res) => {
    ok(res, req, { workflows: db.listWorkflows(authOf(req).workspace.id) });
  });

  app.post("/api/workflows", (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(120), templateId: z.string().optional(), jobId: z.string().optional(), graph: graphSchema.optional() }).parse(req.body);
    const job = body.jobId ? db.job(body.jobId) : undefined;
    if (body.jobId && (!job || job.workspaceId !== authOf(req).workspace.id)) return fail(res, req, 404, "NOT_FOUND", "That dataset doesn’t exist or isn’t yours.");

    // Avoid duplicate workflows: if an unused workflow for this template exists, reuse it
    if (body.templateId) {
      const unused = db.findUnusedTemplateWorkflow(authOf(req).workspace.id, body.templateId);
      if (unused) {
        if (job) {
          const updatedGraph = bindDataset(unused.graph, job);
          db.saveWorkflow(unused.id, { graph: updatedGraph, actorId: authOf(req).user.id });
        }
        return ok(res, req, { workflow: db.workflow(unused.id), reused: true });
      }
    }

    // Disambiguate name if identical name already exists in workspace
    const existingSameNameCount = db.countWorkflowsByNamePrefix(authOf(req).workspace.id, body.name);
    let finalName = body.name;
    if (existingSameNameCount > 0) {
      finalName = `${body.name} (${existingSameNameCount + 1})`;
    }

    const template = body.templateId ? workflowTemplates(body.jobId ?? "").find((item) => item.id === body.templateId) : undefined;
    const graph = bindDataset((body.graph as WorkflowGraph | undefined) ?? template?.graph ?? { nodes: [], edges: [] }, job);
    const workflow = db.createWorkflow({
      workspaceId: authOf(req).workspace.id,
      name: finalName,
      templateId: body.templateId ?? null,
      graph,
      actorId: authOf(req).user.id,
    });
    ok(res, req, { workflow });
  });

  app.delete("/api/workflows/:id", (req, res) => {
    const workflow = ownWorkflow(req, res);
    if (!workflow) return;
    const deleted = db.deleteWorkflow(workflow.id, authOf(req).workspace.id);
    ok(res, req, { deleted, id: workflow.id });
  });

  app.get("/api/workflows/:id", (req, res) => {
    const workflow = ownWorkflow(req, res);
    if (!workflow) return;
    const latestRun = db.latestWorkflowRun(workflow.id);
    ok(res, req, { workflow, latestRun, validation: validateGraph(workflow.graph) });
  });

  app.put("/api/workflows/:id", (req, res) => {
    const workflow = ownWorkflow(req, res);
    if (!workflow) return;
    const body = z.object({ name: z.string().trim().min(1).max(120).optional(), graph: graphSchema }).parse(req.body);
    const saved = db.saveWorkflow(workflow.id, { name: body.name, graph: body.graph as WorkflowGraph, actorId: authOf(req).user.id });
    ok(res, req, { workflow: saved, validation: validateGraph(saved?.graph ?? workflow.graph) });
  });

  app.post("/api/workflows/:id/runs", (req, res) => {
    const workflow = ownWorkflow(req, res);
    if (!workflow?.versionId) return fail(res, req, 409, "EMPTY", "Save the workflow before running it.");
    const body = z.object({
      mode: z.enum(["dry", "live"]).default("dry"),
      autoApprove: z.boolean().optional(),
    }).parse(req.body ?? {});
    const problems = validateGraph(workflow.graph);
    if (problems.length) return fail(res, req, 400, "INVALID_WORKFLOW", problems[0]?.message ?? "The workflow is not valid.");
    const run = db.createWorkflowRun({
      workflowId: workflow.id,
      versionId: workflow.versionId,
      workspaceId: workflow.workspaceId,
      mode: body.mode,
      actorId: authOf(req).user.id,
    });
    if (body.autoApprove) {
      for (const node of workflow.graph.nodes) {
        if (node.kind === "approval") {
          const id = db.ensureApproval(run.id, node.id);
          db.decideApproval(id, "APPROVED", authOf(req).user.id);
        }
      }
    }
    startWorkflowRun(db, run.id, authOf(req).user.id);
    ok(res, req, { run: db.workflowRun(run.id) });
  });

  app.get("/api/workflows/:id/runs/:runId", (req, res) => {
    const workflow = ownWorkflow(req, res);
    if (!workflow) return;
    const run = db.workflowRun(req.params.runId);
    if (!run || run.workflowId !== workflow.id) return fail(res, req, 404, "NOT_FOUND", "That run doesn’t exist.");
    ok(res, req, { run });
  });

  app.post("/api/workflows/:id/runs/:runId/cancel", (req, res) => {
    const workflow = ownWorkflow(req, res);
    if (!workflow) return;
    const run = db.workflowRun(req.params.runId);
    if (!run || run.workflowId !== workflow.id) return fail(res, req, 404, "NOT_FOUND", "That run doesn’t exist.");
    requestWorkflowCancel(run.id);
    db.updateWorkflowRun(run.id, "CANCELLED");
    ok(res, req, { run: db.workflowRun(run.id) });
  });

  app.post("/api/workflows/:id/runs/:runId/approvals/:approvalId", (req, res) => {
    const workflow = ownWorkflow(req, res);
    if (!workflow) return;
    const run = db.workflowRun(req.params.runId);
    if (!run || run.workflowId !== workflow.id) return fail(res, req, 404, "NOT_FOUND", "That run doesn’t exist.");
    const body = z.object({ status: z.enum(["APPROVED", "REJECTED"]) }).parse(req.body);
    const approval = run.approvals.find((item) => item.id === req.params.approvalId);
    if (!approval) return fail(res, req, 404, "NOT_FOUND", "That approval doesn’t exist.");
    db.decideApproval(approval.id, body.status, authOf(req).user.id);
    if (body.status === "APPROVED") startWorkflowRun(db, run.id, authOf(req).user.id);
    else db.updateWorkflowRun(run.id, "CANCELLED", "The approval was declined.");
    ok(res, req, { run: db.workflowRun(run.id) });
  });

  app.get("/api/workflows/:id/runs/:runId/stream", (req, res) => {
    const workflow = db.workflow(req.params.id);
    const run = workflow ? db.workflowRun(req.params.runId) : undefined;
    if (!workflow || workflow.workspaceId !== authOf(req).workspace.id || !run || run.workflowId !== workflow.id) {
      fail(res, req, 404, "NOT_FOUND", "That run doesn’t exist.");
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(run)}\n\n`);
    subscribeWorkflow(run.id, res);
  });

  app.get("/api/agents/lens", (req, res) => {
    const jobs = db.listJobs(authOf(req).workspace.id);
    const jobId = String(req.query.jobId ?? "");
    const job = jobs.find((item) => item.id === jobId);
    if (!jobId || !job) return ok(res, req, { jobs: jobs.map((item) => ({ id: item.id, name: item.name, rowCount: item.rowCount, demo: item.demo })), report: null });
    const version = db.latestVersion(job.id);
    const records = version ? db.recordsForVersion(version.id) : [];
    const diff = db.diffForLatest(job.id) as { firstVersion?: boolean; added?: unknown[]; removed?: unknown[]; changed?: unknown[]; unchanged?: unknown[] } | null;
    const conflicts = db.conflicts(job.id).filter((conflict) => conflict.status === "PENDING").length;
    const scope = db.outreachScope(job.id, job.blueprint.intent, authOf(req).user.id);
    const outreach = db.outreach(scope);
    const marks = Object.values(outreach);
    const report = buildLensReport({
      records: records.map((record) => toAgentRecord(record)),
      added: diff?.added?.length ?? 0,
      removed: diff?.removed?.length ?? 0,
      changed: diff?.changed?.length ?? 0,
      conflicts,
      firstVersion: !diff || Boolean(diff.firstVersion),
      unchanged: diff?.unchanged?.length ?? 0,
      outreach: {
        pending: marks.filter((mark) => mark.status === "pending").length,
        interested: marks.filter((mark) => mark.status === "interested").length,
        declined: marks.filter((mark) => mark.status === "declined").length,
        waiting: marks.filter((mark) => mark.status === "waiting").length,
      },
      workflowRuns: db.workflowRunCounts(authOf(req).workspace.id),
    });
    ok(res, req, { jobs: jobs.map((item) => ({ id: item.id, name: item.name, rowCount: item.rowCount, demo: item.demo })), jobId: job.id, report });
  });

  app.get("/api/agents/missions", (req, res) => {
    ok(res, req, { missions: db.listMissions(authOf(req).workspace.id), starters: missionStarters() });
  });

  app.post("/api/agents/missions", (req, res) => {
    const body = z.object({ objective: z.string().trim().min(3).max(500), jobId: z.string().optional() }).parse(req.body);
    const job = body.jobId ? db.job(body.jobId) : undefined;
    if (body.jobId && (!job || job.workspaceId !== authOf(req).workspace.id)) return fail(res, req, 404, "NOT_FOUND", "That dataset doesn’t exist or isn’t yours.");
    const plan = planMission(body.objective);
    const template = missionWorkflow(plan.templateId, body.jobId ?? "");
    const existingSameNameCount = db.countWorkflowsByNamePrefix(authOf(req).workspace.id, plan.title);
    const wfName = existingSameNameCount > 0 ? `${plan.title} (${existingSameNameCount + 1})` : plan.title;
    const workflow = db.createWorkflow({
      workspaceId: authOf(req).workspace.id,
      name: wfName,
      templateId: plan.templateId,
      graph: bindDataset(template.graph, job),
      actorId: authOf(req).user.id,
    });
    const mission = db.createMission({
      workspaceId: authOf(req).workspace.id,
      title: plan.title,
      objective: body.objective,
      plan,
      workflowId: workflow.id,
      datasetJobId: body.jobId ?? null,
      actorId: authOf(req).user.id,
    });
    ok(res, req, { mission, workflow });
  });

  app.get("/api/agents/missions/:id", (req, res) => {
    const mission = db.mission(req.params.id);
    if (!mission || mission.workspaceId !== authOf(req).workspace.id) return fail(res, req, 404, "NOT_FOUND", "That mission doesn’t exist or isn’t yours.");
    const latestRun = mission.workflowId ? db.latestWorkflowRun(mission.workflowId) : undefined;
    ok(res, req, { mission, latestRun });
  });

  app.post("/api/agents/missions/:id/simulate", (req, res) => {
    const mission = db.mission(req.params.id);
    if (!mission || mission.workspaceId !== authOf(req).workspace.id) return fail(res, req, 404, "NOT_FOUND", "That mission doesn’t exist or isn’t yours.");
    const body = z.object({ minContactability: z.number().optional(), limit: z.number().int().positive().optional(), requireEmail: z.boolean().optional() }).parse(req.body ?? {});
    const job = mission.datasetJobId ? db.job(mission.datasetJobId) : undefined;
    const version = job ? db.latestVersion(job.id) : undefined;
    const records = version && job && job.workspaceId === mission.workspaceId ? db.recordsForVersion(version.id) : [];
    const conflicts = job ? db.conflicts(job.id).filter((conflict) => conflict.status === "PENDING").length : 0;
    const simulation = simulateMission(records.map((record) => toAgentRecord(record)), { ...body, conflicts });
    ok(res, req, { simulation });
  });

  // ---------------------------------------------------------------------------
  // Gauntlet Hackathon Tracker endpoints
  // ---------------------------------------------------------------------------

  const gauntletCreateSchema = z.object({
    name: z.string().trim().min(1).max(200),
    phase: z.enum(["targeting", "ideation", "hacking", "demo", "won"]).optional(),
    targetDate: z.string().trim().max(100).optional().nullable(),
    submitDeadline: z.string().trim().max(100).optional().nullable(),
    roundDate: z.string().trim().max(100).optional().nullable(),
    prizePool: z.string().trim().max(100).optional().nullable(),
    organizer: z.string().trim().max(150).optional().nullable(),
    registrar: z.string().trim().max(150).optional().nullable(),
    track: z.string().trim().max(200).optional().nullable(),
    link: z.string().trim().max(1000).optional().nullable(),
    repoUrl: z.string().trim().max(1000).optional().nullable(),
    deckUrl: z.string().trim().max(1000).optional().nullable(),
    demoUrl: z.string().trim().max(1000).optional().nullable(),
    submissionUrl: z.string().trim().max(1000).optional().nullable(),
    registrantsCount: z.number().int().min(0).optional(),
    roomId: z.string().trim().optional().nullable(),
    checklist: z.array(z.object({
      id: z.string().trim(),
      text: z.string().trim().optional(),
      title: z.string().trim().optional(),
      done: z.boolean().optional(),
      completed: z.boolean().optional(),
      completedAt: z.string().nullable().optional(),
      assignee: z.string().nullable().optional(),
      assignedTo: z.string().nullable().optional(),
      mandatory: z.boolean().optional(),
    })).transform((items) =>
      items.map((it) => ({
        id: it.id,
        text: it.text || it.title || "Task",
        title: it.title || it.text || "Task",
        done: it.done !== undefined ? it.done : Boolean(it.completed),
        completed: it.completed !== undefined ? it.completed : Boolean(it.done),
        assignee: it.assignee || it.assignedTo || undefined,
        assignedTo: it.assignedTo || it.assignee || undefined,
        completedAt: it.completedAt ?? null,
        mandatory: it.mandatory ?? false,
      }))
    ).optional(),
    teammates: z.array(z.object({
      name: z.string().trim().min(1).max(100),
      role: z.string().trim().min(1).max(100),
      email: z.string().trim().max(150).optional(),
    })).optional(),
    tags: z.array(z.string().trim().max(50)).optional(),
    notes: z.string().trim().max(4000).optional().nullable(),
  });

  const gauntletUpdatePatchSchema = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    phase: z.enum(["targeting", "ideation", "hacking", "demo", "won"]).optional(),
    targetDate: z.string().trim().max(100).optional().nullable(),
    submitDeadline: z.string().trim().max(100).optional().nullable(),
    roundDate: z.string().trim().max(100).optional().nullable(),
    prizePool: z.string().trim().max(100).optional().nullable(),
    organizer: z.string().trim().max(150).optional().nullable(),
    registrar: z.string().trim().max(150).optional().nullable(),
    track: z.string().trim().max(200).optional().nullable(),
    link: z.string().trim().max(1000).optional().nullable(),
    repoUrl: z.string().trim().max(1000).optional().nullable(),
    deckUrl: z.string().trim().max(1000).optional().nullable(),
    demoUrl: z.string().trim().max(1000).optional().nullable(),
    submissionUrl: z.string().trim().max(1000).optional().nullable(),
    registrantsCount: z.number().int().min(0).optional(),
    registrantsAsOf: z.string().trim().max(100).optional().nullable(),
    roomId: z.string().trim().optional().nullable(),
    teammates: z.array(z.object({
      name: z.string().trim().min(1).max(100),
      role: z.string().trim().min(1).max(100),
      email: z.string().trim().max(150).optional(),
    })).optional(),
    tags: z.array(z.string().trim().max(50)).optional(),
    notes: z.string().trim().max(4000).optional().nullable(),
    results: z.string().trim().max(4000).optional().nullable(),
  });

  const gauntletAddUpdateSchema = z.object({
    authorName: z.string().trim().min(1).max(100).default("Me"),
    body: z.string().trim().min(1).max(4000),
    badge: z.enum(["update", "blocker", "milestone", "submission"]).default("update"),
  });

  const gauntletRoomCreateSchema = z.object({
    name: z.string().trim().min(1).max(200),
    type: z.enum(["solo", "squad"]).default("squad"),
    description: z.string().trim().max(1000).optional().nullable(),
    ownerRole: z.string().trim().max(100).optional(),
  });

  const gauntletRoomJoinSchema = z.object({
    code: z.string().trim().min(3).max(50),
    name: z.string().trim().min(1).max(100).optional(),
    role: z.string().trim().max(100).optional(),
  });

  const gauntletChecklistUpdateSchema = z.object({
    checklist: z.array(z.object({
      id: z.string().trim(),
      text: z.string().trim().optional(),
      title: z.string().trim().optional(),
      done: z.boolean().optional(),
      completed: z.boolean().optional(),
      completedAt: z.string().nullable().optional(),
      assignee: z.string().nullable().optional(),
      assignedTo: z.string().nullable().optional(),
      mandatory: z.boolean().optional(),
    })).transform((items) =>
      items.map((it) => ({
        id: it.id,
        text: it.text || it.title || "Task",
        title: it.title || it.text || "Task",
        done: it.done !== undefined ? it.done : Boolean(it.completed),
        completed: it.completed !== undefined ? it.completed : Boolean(it.done),
        assignee: it.assignee || it.assignedTo || undefined,
        assignedTo: it.assignedTo || it.assignee || undefined,
        completedAt: it.completedAt ?? null,
        mandatory: it.mandatory ?? false,
      }))
    ),
  });

  // Rooms management
  app.get("/api/agents/gauntlet/rooms", (req, res) => {
    const user = authOf(req).user;
    const workspace = authOf(req).workspace;
    db.ensurePersonalSoloRoom(user.id, workspace.id);
    const rooms = db.listGauntletRooms(user.id, workspace.id);
    ok(res, req, { rooms });
  });

  app.post("/api/agents/gauntlet/rooms", (req, res) => {
    const user = authOf(req).user;
    const workspace = authOf(req).workspace;
    const body = gauntletRoomCreateSchema.parse(req.body);
    const room = db.createGauntletRoom({
      name: body.name,
      type: body.type,
      description: body.description,
      ownerRole: body.ownerRole,
      ownerId: user.id,
      ownerName: user.name || "Squad Captain",
      workspaceId: workspace.id,
    });
    ok(res, req, { room });
  });

  app.get("/api/agents/gauntlet/rooms/:id", (req, res) => {
    const room = db.getGauntletRoom(req.params.id);
    if (!room) return fail(res, req, 404, "NOT_FOUND", "Room not found or access denied.");
    ok(res, req, { room });
  });

  app.post("/api/agents/gauntlet/rooms/join", (req, res) => {
    const user = authOf(req).user;
    const body = gauntletRoomJoinSchema.parse(req.body);
    const room = db.joinGauntletRoom(body.code, {
      id: user.id,
      name: body.name || user.name || "Teammate",
      email: user.email || undefined,
      role: body.role || "Member",
    });
    if (!room) return fail(res, req, 404, "NOT_FOUND", "Invalid room code or room not found.");
    ok(res, req, { room });
  });

  app.patch("/api/agents/gauntlet/rooms/:id", (req, res) => {
    const user = authOf(req).user;
    const body = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(1000).nullable().optional(),
        type: z.enum(["solo", "squad"]).optional(),
      })
      .parse(req.body);

    const updated = db.updateGauntletRoom(req.params.id, user.id, body);
    if (!updated) return fail(res, req, 404, "NOT_FOUND", "Room not found or not owner.");
    ok(res, req, { room: updated });
  });

  app.delete("/api/agents/gauntlet/rooms/:id", (req, res) => {
    const user = authOf(req).user;
    const deleted = db.deleteGauntletRoom(req.params.id, user.id);
    if (!deleted) return fail(res, req, 404, "NOT_FOUND", "Room not found or not owner.");
    ok(res, req, { deleted: true, id: req.params.id });
  });

  // Hackathons inside Gauntlet
  app.get("/api/agents/gauntlet", (req, res) => {
    const user = authOf(req).user;
    const workspace = authOf(req).workspace;
    const roomId = typeof req.query.room === "string" && req.query.room ? req.query.room : null;
    const hackathons = db.listGauntletHackathons(user.id, roomId, workspace.id);
    const activeRoom = roomId ? db.getGauntletRoom(roomId) : null;

    const totalChased = hackathons.length;
    const activeHacking = hackathons.filter((h) => h.phase === "hacking").length;
    const trophiesWon = hackathons.filter((h) => h.phase === "won").length;

    const now = Date.now();
    let closest: { name: string; deadline: string; msLeft: number } | null = null;
    for (const h of hackathons) {
      if (!h.submitDeadline || h.phase === "won") continue;
      const targetTime = new Date(h.submitDeadline).getTime();
      if (!Number.isFinite(targetTime)) continue;
      const msLeft = targetTime - now;
      if (msLeft > 0 && (!closest || msLeft < closest.msLeft)) {
        closest = { name: h.name, deadline: h.submitDeadline, msLeft };
      }
    }

    ok(res, req, {
      hackathons,
      activeRoom,
      stats: {
        totalChased,
        activeHacking,
        trophiesWon,
        closestDeadline: closest ? { name: closest.name, deadline: closest.deadline } : null,
      },
    });
  });

  app.get("/api/agents/gauntlet/available-events", (req, res) => {
    const user = authOf(req).user;
    const workspace = authOf(req).workspace;
    const events = db.listAvailableEventHackathons(workspace.id, user.id);
    ok(res, req, { events });
  });

  app.post("/api/agents/gauntlet", (req, res) => {
    const user = authOf(req).user;
    const workspace = authOf(req).workspace;
    const body = gauntletCreateSchema.parse(req.body);
    const hackathon = db.createGauntletHackathon(user.id, {
      ...body,
      workspaceId: workspace.id,
    });
    ok(res, req, { hackathon });
  });

  app.get("/api/agents/gauntlet/:id", (req, res) => {
    const user = authOf(req).user;
    const hackathon = db.getGauntletHackathon(req.params.id, user.id);
    if (!hackathon) return fail(res, req, 404, "NOT_FOUND", "Hackathon card not found.");
    ok(res, req, { hackathon });
  });

  app.patch("/api/agents/gauntlet/:id", (req, res) => {
    const user = authOf(req).user;
    const body = gauntletUpdatePatchSchema.parse(req.body);
    const updated = db.updateGauntletHackathon(req.params.id, user.id, body);
    if (!updated) return fail(res, req, 404, "NOT_FOUND", "Hackathon card not found.");
    ok(res, req, { hackathon: updated });
  });

  app.put("/api/agents/gauntlet/:id/checklist", (req, res) => {
    const user = authOf(req).user;
    const existing = db.getGauntletHackathon(req.params.id, user.id);
    if (!existing) return fail(res, req, 404, "NOT_FOUND", "Hackathon card not found.");
    const body = gauntletChecklistUpdateSchema.parse(req.body);
    const updated = db.updateGauntletChecklist(req.params.id, body.checklist);
    if (!updated) return fail(res, req, 404, "NOT_FOUND", "Hackathon card not found.");
    ok(res, req, { hackathon: updated });
  });

  app.delete("/api/agents/gauntlet/:id", (req, res) => {
    const user = authOf(req).user;
    const existing = db.getGauntletHackathon(req.params.id, user.id);
    if (!existing) return fail(res, req, 404, "NOT_FOUND", "Hackathon card not found.");
    db.deleteGauntletHackathon(req.params.id, user.id);
    ok(res, req, { deleted: true, id: req.params.id });
  });

  app.post("/api/agents/gauntlet/:id/updates", (req, res) => {
    const user = authOf(req).user;
    const existing = db.getGauntletHackathon(req.params.id, user.id);
    if (!existing) return fail(res, req, 404, "NOT_FOUND", "Hackathon card not found.");
    const body = gauntletAddUpdateSchema.parse(req.body);
    const update = db.addGauntletUpdate(req.params.id, user.id, body.authorName, body.body, body.badge);
    ok(res, req, { update });
  });

  app.post("/api/agents/gauntlet/:id/refresh", (req, res) => {
    const user = authOf(req).user;
    const existing = db.getGauntletHackathon(req.params.id, user.id);
    if (!existing) return fail(res, req, 404, "NOT_FOUND", "Hackathon card not found.");
    const current = existing.registrantsCount || 120;
    const delta = Math.floor(Math.random() * 35) + 5;
    const nextCount = current + delta;
    const now = new Date().toISOString();
    const updated = db.updateGauntletHackathon(req.params.id, user.id, {
      registrantsCount: nextCount,
      registrantsAsOf: now,
    });
    ok(res, req, { hackathon: updated, syncedAt: now });
  });
}
