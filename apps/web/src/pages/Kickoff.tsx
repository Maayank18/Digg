import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  CheckCircle2,
  Clock,
  Compass,
  Edit3,
  ExternalLink,
  Layers,
  Rocket,
  RotateCw,
  Search,
  Sparkles,
  Target,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { AppWindow } from "../components/Shell";
import { eventStored, ROOT_CRUMB, useEvents, type DigEvent } from "../events";
import { notify, notifyError } from "../toast";

interface KickoffTask {
  id: string;
  title: string;
  why: string;
  due: string;
  search: { folder: string; query: string } | null;
}

interface KickoffPlan {
  eventName: string;
  eventDate: string;
  today: string;
  daysLeft: number | null;
  urgent: boolean;
  summary: string;
  assumptions: string[];
  phases: Array<{ title: string; start: string; end: string; tasks: KickoffTask[] }>;
}

interface Saved {
  request: string;
  plan: KickoffPlan;
  done: string[];
  updatedAt: string;
}

const FOLDER_NOUN: Record<string, string> = {
  sponsors: "sponsors",
  judges: "judges & speakers",
  jobs: "open roles",
  leads: "target leads",
  competitors: "competitors",
  events: "hackathons & events",
  papers: "research papers",
};

interface ScenarioPreset {
  id: string;
  badge: string;
  title: string;
  desc: string;
  prompt: string;
}

const PRESETS: ScenarioPreset[] = [
  {
    id: "ai-hackathon",
    badge: "AI Hackathon",
    title: "36-Hour College Hackathon",
    desc: "300 builders, 6 weeks out · Needs sponsors, judges & mentors",
    prompt:
      "Our first 36-hour college AI hackathon for about 300 student developers in Delhi NCR, scheduled for 6 weeks from now. We have never done this and urgently need tech sponsors, track judges, mentors, and venue confirmation.",
  },
  {
    id: "tech-conf",
    badge: "Tech Summit",
    title: "250-Person Developer Conference",
    desc: "Mumbai · 4 weeks away, venue shortlisted · Needs keynotes & sponsors",
    prompt:
      "A 250-person single-day developer and cloud architecture summit in Mumbai, exactly 4 weeks away. Venue is tentatively booked. We urgently need keynote speakers, session judges, and bronze/silver sponsors.",
  },
  {
    id: "web3-hackfest",
    badge: "Virtual Summit",
    title: "Global Web3 & Open Source Hackfest",
    desc: "$25,000 prize pool, 45 days out · Tooling credits & jury",
    prompt:
      "A virtual global open-source and Web3 hackathon with a $25,000 prize pool, happening 45 days from today. Looking for developer platform sponsors, cloud credits, and technical mentors.",
  },
  {
    id: "demo-day",
    badge: "Demo Day",
    title: "Startup Pitch Showcase",
    desc: "40 pre-seed startups & 80 VCs · 3 weeks urgent timeline",
    prompt:
      "Curated investor demo day for 40 pre-seed and seed AI startups pitching to 80 angel investors and VCs in Bangalore in 3 weeks. Urgent venue locking, pitch judges, and investor outreach.",
  },
];

const SYNTHESIS_STAGES = [
  "Analyzing event scope, audience scale & timeline horizon...",
  "Backwards-scheduling critical path milestones from target date...",
  "Synthesizing targeted sponsor, speaker & judge intelligence queries...",
  "Calibrating phase dependencies, buffer cycles & deliverables...",
];

function shortDate(iso: string) {
  return iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "";
}

/** Kickoff: Autonomous Event Strategist & Executive Execution Engine */
export function Kickoff() {
  const [params, setParams] = useSearchParams();
  const eventId = params.get("event") ?? "";
  const { events } = useEvents();
  const client = useQueryClient();
  const [request, setRequest] = useState("");
  const [synthesisStage, setSynthesisStage] = useState(0);
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);

  const savedQ = useQuery({
    queryKey: ["kickoff", eventId],
    queryFn: () => api<{ saved: Saved | null }>(`/api/kickoff/${eventId}`),
    enabled: Boolean(eventId),
  });
  const saved = eventId ? savedQ.data?.saved ?? null : null;

  // Picking an event with an earlier plan shows what was asked last time.
  useEffect(() => {
    setRequest(saved?.request ?? "");
    if (saved?.plan) setIsEditingPrompt(false);
  }, [eventId, saved?.request, saved?.plan]);

  const plan = useMutation({
    mutationFn: () =>
      api<{ event: DigEvent; saved: Saved }>("/api/kickoff", {
        method: "POST",
        body: JSON.stringify({ request, ...(eventId ? { eventId } : {}) }),
      }),
    onSuccess: (result) => {
      eventStored(result.event);
      client.setQueryData(["kickoff", result.event.id], { saved: result.saved });
      if (!eventId) notify(`Created the event “${result.event.name}” with its plan`, "info");
      setParams({ event: result.event.id });
      setIsEditingPrompt(false);
    },
    onError: (error) => notifyError(error),
  });

  // Progressive synthesis stage animator while plan is computing
  useEffect(() => {
    if (!plan.isPending) {
      setSynthesisStage(0);
      return;
    }
    const interval = setInterval(() => {
      setSynthesisStage((prev) => (prev < SYNTHESIS_STAGES.length - 1 ? prev + 1 : prev));
    }, 4500);
    return () => clearInterval(interval);
  }, [plan.isPending]);

  const toggle = async (taskId: string) => {
    if (!saved || !eventId) return;
    const done = saved.done.includes(taskId) ? saved.done.filter((id) => id !== taskId) : [...saved.done, taskId];
    client.setQueryData(["kickoff", eventId], { saved: { ...saved, done } });
    try {
      await api(`/api/kickoff/${eventId}/done`, { method: "PUT", body: JSON.stringify({ done }) });
    } catch (error) {
      client.setQueryData(["kickoff", eventId], { saved });
      notifyError(error);
    }
  };

  const view = saved?.plan;
  const currentEvent = events.find((event) => event.id === eventId);
  const navigate = useNavigate();

  /** True when this event's folder already holds a search, so the task opens its results. */
  const filedIn = (folder: string) => Boolean(currentEvent?.jobs[folder as keyof DigEvent["jobs"]]);

  /** An empty folder: start the search with the plan's query and go to the folder to watch it run. */
  const startSearch = useMutation({
    mutationFn: (query: string) =>
      api<{ folder: string; event: DigEvent }>(`/api/events/${eventId}/searches`, { method: "POST", body: JSON.stringify({ query }) }),
    onSuccess: (result) => {
      eventStored(result.event);
      navigate(`/events/${eventId}/${result.folder}`);
    },
    onError: (error) => notifyError(error),
  });

  const total = view?.phases.reduce((sum, phase) => sum + phase.tasks.length, 0) ?? 0;
  const completedCount = saved?.done.length ?? 0;
  const completionPct = total > 0 ? Math.round((completedCount / total) * 100) : 0;

  // Extract all unique auto-search recommendations in this plan
  const recommendedSearches = useMemo(() => {
    if (!view) return [];
    const map = new Map<string, { folder: string; query: string }>();
    for (const phase of view.phases) {
      for (const task of phase.tasks) {
        if (task.search && !map.has(task.search.folder)) {
          map.set(task.search.folder, task.search);
        }
      }
    }
    return Array.from(map.values());
  }, [view]);

  return (
    <AppWindow
      crumbs={[{ label: ROOT_CRUMB, to: "/dashboard" }, { label: "Toolkit", to: "/agents" }, { label: "Kickoff" }]}
      sidebar="agents"
    >
      <div className="content">
        <div className="kickoff-container">
          {/* Header */}
          <header className="kickoff-header">
            <div className="kickoff-eyebrow">
              <Sparkles size={13} />
              <span>Autonomous Event Strategist &amp; Execution Engine</span>
            </div>
            <h1>Event Kickoff Blueprint</h1>
            <p>
              Turn a rough event idea or date constraint into a backwards-scheduled critical path. Kickoff dates every
              milestone, flags urgent bottlenecks, and auto-generates deep web intelligence searches for sponsors, speakers,
              and venues.
            </p>
          </header>

          {/* Superpowers 3-Column Highlights Grid (Explains what the feature actually does) */}
          <div className="kickoff-superpowers">
            <div className="kickoff-superpower-card">
              <div className="kickoff-superpower-icon" style={{ background: "rgba(59, 130, 246, 0.12)", color: "#2563eb" }}>
                <Calendar size={18} />
              </div>
              <h4>Backwards-Dated Timeline</h4>
              <p>Calculates your exact date horizon and backwards-schedules milestones from event day so nothing slips.</p>
            </div>
            <div className="kickoff-superpower-card">
              <div className="kickoff-superpower-icon" style={{ background: "rgba(16, 185, 129, 0.12)", color: "#059669" }}>
                <Zap size={18} />
              </div>
              <h4>Deep Intelligence Dispatch</h4>
              <p>Deep-links tasks to live web research to discover vetted sponsors, judges, and benchmark events with 1 click.</p>
            </div>
            <div className="kickoff-superpower-card">
              <div className="kickoff-superpower-icon" style={{ background: "rgba(245, 158, 11, 0.12)", color: "#d97706" }}>
                <Clock size={18} />
              </div>
              <h4>Critical Path &amp; Risk Guard</h4>
              <p>Detects tight schedules (&lt;30 days), flags bottlenecks early, and advises what to streamline or cut.</p>
            </div>
          </div>

          {/* Prompting Form (Shown when no plan exists OR when user expands "Edit / Re-plan") */}
          {(!view || isEditingPrompt) && (
            <div className="kickoff-form-card">
              <div className="kickoff-form-row">
                <label htmlFor="event-target-select">1. Target Event Workspace</label>
                <select
                  id="event-target-select"
                  aria-label="Event"
                  className="kickoff-select-target"
                  value={eventId}
                  onChange={(event) => setParams(event.target.value ? { event: event.target.value } : {})}
                >
                  <option value="">✨ + Create New Event (Kickoff configures it)</option>
                  {events
                    .filter((event) => !event.archived)
                    .map((event) => (
                      <option key={event.id} value={event.id}>
                        {event.name}
                        {event.date ? ` · ${event.date}` : ""}
                      </option>
                    ))}
                </select>
              </div>

              {/* Interactive Scenario Presets */}
              <div className="kickoff-presets-container">
                <div className="kickoff-presets-label">
                  <Rocket size={12} color="#3b82f6" />
                  <span>Quick-Start Scenarios (Click to test or customize)</span>
                </div>
                <div className="kickoff-presets-grid">
                  {PRESETS.map((preset) => (
                    <button
                      type="button"
                      key={preset.id}
                      className="kickoff-preset-chip"
                      onClick={() => setRequest(preset.prompt)}
                    >
                      <div className="kickoff-preset-info">
                        <span className="kickoff-preset-badge">{preset.badge}</span>
                        <span className="kickoff-preset-title">{preset.title}</span>
                      </div>
                      <ArrowRight size={13} style={{ opacity: 0.6, flexShrink: 0 }} />
                    </button>
                  ))}
                </div>
              </div>

              {/* Textarea Input */}
              <div className="kickoff-input-wrapper">
                <label htmlFor="kickoff-request-textarea" style={{ fontSize: 12, fontWeight: 650, color: "var(--text-2)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  2. Describe the Event, Constraints &amp; Timeline
                </label>
                <textarea
                  id="kickoff-request-textarea"
                  className="kickoff-textarea"
                  rows={4}
                  value={request}
                  onChange={(event) => setRequest(event.target.value)}
                  maxLength={2000}
                  placeholder={
                    eventId
                      ? "What has changed or what is worrying you? e.g. “The date moved to 10 Oct. No sponsors or judges confirmed yet.”"
                      : "Describe the event in your own words. e.g. “Our first developer conference, about 200 people in Mumbai, sometime next month. We have never done this.”"
                  }
                />
                <div className="kickoff-input-footer">
                  <span>Be specific about city, estimated audience size, and target date for highest precision.</span>
                  <span>{request.length} / 2000</span>
                </div>
              </div>

              {/* Actions Bar */}
              <div className="kickoff-form-actions">
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button
                    className="kickoff-submit-btn"
                    disabled={plan.isPending || request.trim().length < 10}
                    onClick={() => plan.mutate()}
                  >
                    {plan.isPending ? (
                      <>
                        <RotateCw size={14} className="spin-slow" />
                        <span>Synthesizing Blueprint…</span>
                      </>
                    ) : view ? (
                      <>
                        <Sparkles size={14} />
                        <span>Re-plan &amp; Update Blueprint</span>
                      </>
                    ) : (
                      <>
                        <Sparkles size={14} />
                        <span>Generate Executive Blueprint</span>
                      </>
                    )}
                  </button>
                  {view && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setIsEditingPrompt(false)}
                      style={{ fontSize: 12.5 }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
                {view && (
                  <span className="kickoff-action-note">
                    Re-planning recalculates all phase dates and creates a fresh checklist.
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Active Synthesis Loading Container */}
          {plan.isPending && (
            <div className="kickoff-synthesis-state">
              <div className="kickoff-synthesis-header">
                <div className="kickoff-synthesis-spinner" />
                <h3>Synthesizing Autonomous Event Blueprint</h3>
              </div>
              <div className="kickoff-synthesis-steps">
                {SYNTHESIS_STAGES.map((label, idx) => {
                  const isDone = idx < synthesisStage;
                  const isActive = idx === synthesisStage;
                  return (
                    <div
                      key={label}
                      className={`kickoff-synthesis-step ${isActive ? "active" : isDone ? "done" : ""}`}
                    >
                      <div className="kickoff-step-bullet" />
                      <span>{label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Loading Indicator for Existing Saved Plan */}
          {eventId && savedQ.isLoading && !plan.isPending && (
            <p className="kickoff-muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <RotateCw size={13} className="spin-slow" /> Loading event blueprint…
            </p>
          )}

          {/* Executive Event Blueprint (Result Dashboard) */}
          {view && !plan.isPending && (
            <section className="kickoff-plan-container">
              {/* Blueprint Header Banner */}
              <div className="kickoff-blueprint-banner">
                <div className="kickoff-banner-left">
                  <div className="kickoff-blueprint-badge">
                    <Sparkles size={11} />
                    <span>Executive Event Blueprint</span>
                  </div>
                  <h2>{view.eventName}</h2>
                  <div className="kickoff-blueprint-meta-row">
                    <span className="kickoff-meta-pill">
                      <Calendar size={13} color="#2563eb" />
                      <span>{view.eventDate ? shortDate(view.eventDate) : "Flexible date horizon"}</span>
                    </span>
                    {view.daysLeft !== null && (
                      <span className="kickoff-meta-pill">
                        <Clock size={13} color="#6b7280" />
                        <span>{view.daysLeft} days remaining</span>
                      </span>
                    )}
                    {view.urgent && (
                      <span className="kickoff-meta-pill urgent" title="Fewer than 30 days left: Critical path accelerated">
                        <AlertTriangle size={13} />
                        <span>Tight Timeline · Critical Path</span>
                      </span>
                    )}
                  </div>
                </div>

                <div className="kickoff-banner-right">
                  <div className="kickoff-progress-box">
                    <span className="kickoff-progress-text">
                      {completedCount} of {total} Tasks Complete ({completionPct}%)
                    </span>
                    <div className="kickoff-progress-bar-bg">
                      <div
                        className="kickoff-progress-bar-fill"
                        style={{ width: `${completionPct}%` }}
                      />
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {!isEditingPrompt && (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setIsEditingPrompt(true)}
                        title="Adjust constraints or details and re-plan"
                        style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}
                      >
                        <Edit3 size={12} />
                        <span>Refine</span>
                      </button>
                    )}
                    <Link to={`/events/${eventId}`} className="kickoff-workspace-btn">
                      <span>Open Workspace</span>
                      <ArrowRight size={13} />
                    </Link>
                  </div>
                </div>
              </div>

              {/* Strategy & Tactical Directives Card */}
              <div className="kickoff-strategy-card">
                <div className="kickoff-strategy-header">
                  <Sparkles size={14} />
                  <span>Strategic Executive Summary</span>
                </div>
                {view.summary && <p className="kickoff-strategy-summary">{view.summary}</p>}

                {/* Key Planning Assumptions */}
                {view.assumptions.length > 0 && (
                  <div className="kickoff-assumptions-list">
                    <span className="kickoff-assumptions-title">Assumptions:</span>
                    {view.assumptions.map((assumed) => (
                      <span key={assumed} className="kickoff-assumption-tag">
                        {assumed}
                      </span>
                    ))}
                  </div>
                )}

                {/* Quick-Launch Deep Search Hub */}
                {recommendedSearches.length > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingTop: 8, borderTop: "1px dashed var(--hairline)" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-3)", display: "flex", alignItems: "center", gap: 4 }}>
                      <Zap size={11} color="#f59e0b" />
                      <span>Intelligence Launchpad:</span>
                    </span>
                    {recommendedSearches.map((rec) => {
                      const isFiled = filedIn(rec.folder);
                      return isFiled ? (
                        <Link
                          key={rec.folder}
                          className="kickoff-search-pill ready"
                          to={`/events/${eventId}/${rec.folder}`}
                          title={`Open ${FOLDER_NOUN[rec.folder] ?? rec.folder} results already filed`}
                        >
                          <CheckCircle2 size={12} />
                          <span>View {FOLDER_NOUN[rec.folder] ?? rec.folder}</span>
                          <ArrowRight size={11} />
                        </Link>
                      ) : (
                        <button
                          key={rec.folder}
                          type="button"
                          className="kickoff-search-pill trigger"
                          title={`Auto-dig: "${rec.query}"`}
                          disabled={startSearch.isPending}
                          onClick={() => startSearch.mutate(rec.query)}
                        >
                          <Search size={12} />
                          <span>
                            {startSearch.isPending && startSearch.variables === rec.query
                              ? "Starting…"
                              : `Dig ${FOLDER_NOUN[rec.folder] ?? rec.folder}`}
                          </span>
                          <ArrowRight size={11} />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Phased Milestone Timeline Section */}
              <div className="kickoff-timeline-section">
                {view.phases.map((phase, pIdx) => {
                  const phaseCompleted = phase.tasks.filter((t) => saved?.done.includes(t.id)).length;
                  return (
                    <div key={phase.title} className="kickoff-phase-card">
                      <div className="kickoff-phase-header">
                        <div className="kickoff-phase-title-group">
                          <span className="kickoff-phase-number">Phase {pIdx + 1}</span>
                          <h3>{phase.title}</h3>
                        </div>
                        <div className="kickoff-phase-dates">
                          <Calendar size={13} style={{ opacity: 0.7 }} />
                          <span>
                            {shortDate(phase.start)}
                            {phase.end !== phase.start ? ` – ${shortDate(phase.end)}` : ""}
                          </span>
                          <span style={{ marginLeft: 8, fontWeight: 600, color: "var(--text-2)" }}>
                            ({phaseCompleted}/{phase.tasks.length} done)
                          </span>
                        </div>
                      </div>

                      <ul className="kickoff-task-list">
                        {phase.tasks.map((task) => {
                          const done = saved?.done.includes(task.id) ?? false;
                          return (
                            <li key={task.id} className={`kickoff-task-item ${done ? "done" : ""}`}>
                              <input
                                type="checkbox"
                                className="kickoff-task-checkbox"
                                checked={done}
                                onChange={() => void toggle(task.id)}
                                aria-label={`Done: ${task.title}`}
                              />
                              <div className="kickoff-task-content">
                                <span className="kickoff-task-title">{task.title}</span>
                                {task.why && <span className="kickoff-task-why">{task.why}</span>}
                              </div>

                              <div className="kickoff-action-cell">
                                {task.search ? (
                                  filedIn(task.search.folder) ? (
                                    <Link
                                      className="kickoff-search-pill ready"
                                      to={`/events/${eventId}/${task.search.folder}`}
                                      title="Open verified results already discovered in this folder"
                                    >
                                      <CheckCircle2 size={12} />
                                      <span>In {FOLDER_NOUN[task.search.folder] ?? "folder"}</span>
                                      <ArrowRight size={11} />
                                    </Link>
                                  ) : (
                                    <button
                                      type="button"
                                      className="kickoff-search-pill trigger"
                                      title={`Auto-digs: "${task.search.query}"`}
                                      disabled={startSearch.isPending}
                                      onClick={() => startSearch.mutate(task.search!.query)}
                                    >
                                      <Search size={12} />
                                      <span>
                                        {startSearch.isPending && startSearch.variables === task.search.query
                                          ? "Starting…"
                                          : `Dig ${FOLDER_NOUN[task.search.folder] ?? "results"}`}
                                      </span>
                                      <ArrowRight size={11} />
                                    </button>
                                  )
                                ) : (
                                  <span />
                                )}
                              </div>

                              <div className="kickoff-due-badge">
                                <Clock size={11} style={{ opacity: 0.7 }} />
                                <span>{shortDate(task.due)}</span>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>

              <p className="kickoff-muted" style={{ textAlign: "center", marginTop: 8 }}>
                Suggested autonomous event blueprint generated by Dig. All milestones and web intelligence searches are
                automatically saved with this event.
              </p>
            </section>
          )}
        </div>
      </div>
    </AppWindow>
  );
}
