import { useQuery } from "@tanstack/react-query";
import { LogOut, Pencil } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ago, api, type JobSummary } from "../api";
import { AppWindow } from "../components/Shell";
import { ROOT_CRUMB, useEvents } from "../events";
import { queryClient } from "../query";
import { initials, logOut, useSession, type Session } from "../session";

const INTENT_NAMES: Record<string, string> = {
  SPONSOR_LOOKUP: "Sponsors",
  JUDGE_LOOKUP: "Judges & Mentors",
  JOB_LOOKUP: "Jobs",
  LEAD_LOOKUP: "Leads",
  COMPETITOR_LOOKUP: "Competitors",
  EVENT_LOOKUP: "Hackathons & Events",
  PAPER_LOOKUP: "Research Papers",
};

export function Profile() {
  const { session } = useSession();
  const { events } = useEvents();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const jobsQ = useQuery({ queryKey: ["jobs"], queryFn: () => api<{ jobs: JobSummary[] }>("/api/jobs") });
  if (!session) return null;
  const { user } = session;

  const searches = (jobsQ.data?.jobs ?? []).filter((job) => job.versionNumber !== null).sort((a, b) => (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? ""));
  const records = searches.reduce((sum, job) => sum + job.rowCount, 0);
  const pending = searches.reduce((sum, job) => sum + job.pendingConflicts, 0);
  const active = events.filter((event) => !event.archived);
  const eventFor = (jobId: string) => events.find((event) => Object.values(event.jobs).includes(jobId));
  const wait = jobsQ.isLoading ? "…" : null;

  const stats: Array<[string, string | number]> = [
    ["Active events", active.length],
    ["Favourites", active.filter((event) => event.favourite).length],
    ["Archived", events.length - active.length],
    ["Searches with results", wait ?? searches.length],
    ["Records collected", wait ?? records.toLocaleString()],
    ["Conflicts to review", wait ?? pending],
  ];

  return (
    <AppWindow crumbs={[{ label: ROOT_CRUMB, to: "/dashboard" }, { label: "Profile" }]} sidebar="profile">
      <div className="content profile">
        <section className="card profile-card">
          <div className="profile-avatar">{initials(user.name)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1>{user.name}</h1>
            <div className="sub">{user.email}</div>
            {user.role && <div className="sub">{user.role}</div>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={() => setEditing(true)}>
              <Pencil size={13} /> Edit profile
            </button>
            <button className="btn" onClick={() => void logOut().finally(() => navigate("/"))}>
              <LogOut size={13} /> Log out
            </button>
          </div>
        </section>

        <h5>Workspace</h5>
        <div className="profile-stats">
          {stats.map(([label, value]) => (
            <div key={label} className="card">
              <div className="cap">{label}</div>
              <div className="stat">{value}</div>
            </div>
          ))}
        </div>

        <h5>Recent searches</h5>
        {jobsQ.isError ? (
          <p className="err">Couldn’t load your searches: {jobsQ.error instanceof Error ? jobsQ.error.message : String(jobsQ.error)}</p>
        ) : searches.length === 0 ? (
          <p className="profile-note">{jobsQ.isLoading ? "Loading…" : "No searches yet. Open an event and click Got Something Else? to start one."}</p>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            {searches.slice(0, 8).map((job) => {
              const event = eventFor(job.id);
              return (
                <Link key={job.id} to={`/jobs/${job.id}`} className="side-item profile-row">
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <b>{job.name}</b>
                    <span className="sub">
                      {INTENT_NAMES[job.blueprint.intent] ?? job.blueprint.intent} · “{job.query}” · {job.rowCount} records · v{job.versionNumber}
                      {event ? ` · in ${event.name}` : ""}
                    </span>
                  </span>
                  <span className="count">{ago(job.lastRunAt ?? job.updatedAt)}</span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
      {editing && <ProfileSheet name={user.name} role={user.role} email={user.email} onClose={() => setEditing(false)} />}
    </AppWindow>
  );
}

function ProfileSheet(props: { name: string; role: string; email: string; onClose: () => void }) {
  const [values, setValues] = useState({ name: props.name, role: props.role });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api<Session>("/api/auth/me", { method: "PATCH", body: JSON.stringify(values) });
      queryClient.setQueryData(["me"], session);
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn’t save your profile.");
      setBusy(false);
    }
  };
  return (
    <div className="scrim" onClick={props.onClose}>
      <form className="sheet" onSubmit={submit} onClick={(event) => event.stopPropagation()}>
        <h3>Edit profile</h3>
        <label>Name</label>
        <input autoFocus value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} />
        <label>Role</label>
        <input value={values.role} onChange={(event) => setValues({ ...values, role: event.target.value })} placeholder="Sponsorship lead" />
        <label>Email</label>
        <input value={props.email} disabled title="Your login email can’t be changed here." />
        {error && <p className="err" style={{ margin: "10px 0 0" }}>{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn blue" disabled={busy || !values.name.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
