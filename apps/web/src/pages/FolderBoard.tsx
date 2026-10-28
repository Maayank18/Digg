import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, FolderSync, Plus, RotateCw, Search, Sparkles } from "lucide-react";
import { useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { FOLDER_INTENTS } from "@dig/schemas";
import { ago, api, type JobSummary } from "../api";
import { AppWindow, FolderIcon, type Crumb } from "../components/Shell";
import { FOLDERS, folderLabel, linkJob, ROOT_CRUMB, useEvents, type DigEvent, type FolderKey } from "../events";
import { NewQuerySheet } from "./EventFolder";
import { JobBoard } from "./JobBoard";

/** /events/:eventId/:folder — the Workspace Hub and Job Board for that event folder. */
export function FolderBoard() {
  const { eventId = "", folder = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { events, loading } = useEvents();
  const event = events.find((item) => item.id === eventId);
  const meta = FOLDERS.find((item) => item.key === folder);

  const [asking, setAsking] = useState(false);
  const [initialQ, setInitialQ] = useState<string | undefined>(undefined);

  if (loading) {
    return (
      <AppWindow crumbs={[{ label: ROOT_CRUMB, to: "/dashboard" }]} sidebar={false}>
        <div className="empty">Loading…</div>
      </AppWindow>
    );
  }
  if (!event || !meta) return <Navigate to={event ? `/events/${eventId}` : "/dashboard"} replace />;

  const folderIcon = <FolderIcon size={17} />;
  const label = folderLabel(event, meta.key);
  const jobId = event.jobs[meta.key];
  const showBoard = params.get("board") === "1";

  // If a search is already active and the user selected to view the data table
  if (jobId && showBoard) {
    return (
      <>
        <JobBoard
          key={jobId}
          jobId={jobId}
          crumbs={[
            { label: event.name, to: `/events/${event.id}`, icon: folderIcon },
            { label, to: `/events/${event.id}/${meta.key}`, icon: folderIcon },
            { label: "Data Table", icon: folderIcon },
          ]}
          onSwitchSearch={() => setParams({})}
          onNewSearch={() => {
            setInitialQ(meta.example);
            setAsking(true);
          }}
        />
        {asking && (
          <NewQuerySheet
            event={event}
            initialQuery={initialQ ?? meta.example}
            onClose={() => setAsking(false)}
          />
        )}
      </>
    );
  }

  // Otherwise, present the Folder Workspace Hub (letting the user select between active table, previous works, or starting new)
  const crumbs: Crumb[] = [
    { label: event.name, to: `/events/${event.id}`, icon: folderIcon },
    { label: "Job Board", to: `/events/${event.id}`, icon: folderIcon },
    { label, icon: folderIcon },
  ];

  return (
    <FolderHub
      event={event}
      folder={meta.key}
      label={label}
      crumbs={crumbs}
      activeJobId={jobId}
      onOpenBoard={() => setParams({ board: "1" })}
    />
  );
}

function FolderHub(props: {
  event: DigEvent;
  folder: FolderKey;
  label: string;
  crumbs: Crumb[];
  activeJobId?: string;
  onOpenBoard: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [initialQ, setInitialQ] = useState<string | undefined>(undefined);
  const meta = FOLDERS.find((item) => item.key === props.folder)!;
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: () => api<{ jobs: JobSummary[] }>("/api/jobs") });

  // Your earlier searches of the same kind that already have results can be filed here.
  const reusable = (jobs.data?.jobs ?? []).filter(
    (job) => job.blueprint.intent === FOLDER_INTENTS[props.folder] && job.versionNumber !== null,
  );
  const activeJob = props.activeJobId
    ? jobs.data?.jobs?.find((j) => j.id === props.activeJobId)
    : undefined;

  const startWith = (q: string) => {
    setInitialQ(q);
    setAsking(true);
  };

  const handleUseSearch = async (jobId: string) => {
    await linkJob(props.event.id, props.folder, jobId);
    props.onOpenBoard();
  };

  return (
    <AppWindow crumbs={props.crumbs} sidebar={false}>
      <div className="empty" style={{ padding: "32px 16px 64px" }}>
        <div style={{ maxWidth: 580, width: "100%", margin: "0 auto" }}>
          {/* Active Search Hero Card (when data has already been generated) */}
          {activeJob ? (
            <div
              style={{
                background: "var(--card)",
                border: "1px solid var(--hairline)",
                borderLeft: "4px solid #3b82f6",
                borderRadius: 12,
                padding: "20px 22px",
                textAlign: "left",
                marginBottom: 24,
                boxShadow: "0 2px 10px rgba(0, 0, 0, 0.04)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "#059669",
                  }}
                >
                  <CheckCircle2 size={13} />
                  <span>Active Search in this Folder</span>
                </span>
                <span style={{ fontSize: 11, color: "var(--text-3)" }}>
                  Updated {ago(activeJob.lastRunAt ?? activeJob.updatedAt)}
                </span>
              </div>

              <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 700, color: "var(--text)" }}>
                {activeJob.name}
              </h2>
              <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
                “{activeJob.query}” · <b>{activeJob.rowCount} records discovered</b>
              </p>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <button
                  className="btn blue"
                  onClick={props.onOpenBoard}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600 }}
                >
                  <span>Continue working on this table</span>
                  <ArrowRight size={14} />
                </button>
                <button
                  className="btn"
                  onClick={() => startWith(meta.example)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                >
                  <Plus size={13} />
                  <span>Start a new {props.folder === "judges" ? "judge & mentor" : meta.noun} search</span>
                </button>
              </div>
            </div>
          ) : (
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ margin: "0 0 6px", fontSize: 20, fontWeight: 700, color: "var(--text)" }}>
                No {meta.noun} search in this folder yet
              </h3>
              <p style={{ margin: "0 0 16px", fontSize: 13.5, color: "var(--text-2)" }}>
                Start a new live search, or file one of your earlier searches here.
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                <button className="btn blue" onClick={() => startWith(meta.example)}>
                  Start a {props.folder === "judges" ? "judge & mentor" : meta.noun} search
                </button>
                {props.folder === "judges" && (
                  <button
                    className="btn"
                    onClick={() => startWith("Keynote speakers and tech experts for our hackathon in India")}
                  >
                    Start a speaker search
                  </button>
                )}
              </div>
            </div>
          )}

          {jobs.isError && (
            <p className="err" style={{ marginTop: 16 }}>
              Couldn’t load your earlier searches: {String(jobs.error)}
            </p>
          )}

          {/* Previous Searches of this kind (reusable works) */}
          <div style={{ textAlign: "left", marginTop: activeJob ? 10 : 20 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <h4
                style={{
                  margin: 0,
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--text-2)",
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                <FolderSync size={13} />
                <span>Your Previous {meta.label} Searches ({reusable.length})</span>
              </h4>
              <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
                Select any previous work to file it here
              </span>
            </div>

            {reusable.length === 0 ? (
              <div
                style={{
                  background: "var(--card)",
                  border: "1px dashed var(--hairline)",
                  borderRadius: 10,
                  padding: "16px 20px",
                  textAlign: "center",
                  fontSize: 12.5,
                  color: "var(--text-3)",
                }}
              >
                No earlier searches of this kind found. Start a new search above to create one.
              </div>
            ) : (
              <div
                className="card"
                style={{
                  padding: 0,
                  maxHeight: 340,
                  overflow: "auto",
                  border: "1px solid var(--hairline)",
                  borderRadius: 10,
                }}
              >
                {reusable.map((job) => {
                  const isCurrent = job.id === props.activeJobId;
                  return (
                    <div
                      key={job.id}
                      style={{
                        padding: "12px 16px",
                        borderBottom: "1px solid var(--line)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        background: isCurrent ? "rgba(16, 185, 129, 0.04)" : "transparent",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                          <b style={{ fontWeight: 600, fontSize: 13.5, color: "var(--text)" }}>{job.name}</b>
                          {isCurrent && (
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                textTransform: "uppercase",
                                padding: "1px 6px",
                                borderRadius: 4,
                                background: "rgba(16, 185, 129, 0.12)",
                                color: "#059669",
                              }}
                            >
                              Active
                            </span>
                          )}
                        </div>
                        <span
                          style={{
                            display: "block",
                            fontSize: 12,
                            color: "var(--text-2)",
                            marginTop: 2,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          “{job.query}” · <b>{job.rowCount} records</b> · {ago(job.lastRunAt ?? job.updatedAt)}
                        </span>
                      </div>

                      {isCurrent ? (
                        <button
                          className="btn"
                          onClick={props.onOpenBoard}
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            padding: "5px 12px",
                            whiteSpace: "nowrap",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <span>Open Table</span>
                          <ArrowRight size={12} />
                        </button>
                      ) : (
                        <button
                          className="btn blue"
                          onClick={() => void handleUseSearch(job.id)}
                          style={{ fontSize: 12, fontWeight: 600, padding: "5px 12px", whiteSpace: "nowrap" }}
                        >
                          Use this search
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
      {asking && (
        <NewQuerySheet
          event={props.event}
          initialQuery={initialQ ?? meta.example}
          onClose={() => setAsking(false)}
        />
      )}
    </AppWindow>
  );
}
