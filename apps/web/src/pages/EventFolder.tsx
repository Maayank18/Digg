import { BookOpen, Pencil, Plus } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { FolderKey } from "@dig/schemas";
import { ApiError, api, type JobSummary } from "../api";
import { AppWindow, FolderTile, NewFolderIcon } from "../components/Shell";
import { eventStored, FOLDERS, folderLabel, renameFolder, ROOT_CRUMB, touchEvent, unlinkJob, updateEvent, useEvents, type DigEvent } from "../events";
import { EventSheet } from "./EventSheet";
import { Tip } from "../components/Tip";
import { EVENT_HELP } from "../help";

export function EventFolder() {
  const { eventId = "" } = useParams();
  const { events, loading } = useEvents();
  const event = events.find((item) => item.id === eventId);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [params, setParams] = useSearchParams();
  const ask = params.get("ask") ?? "";

  useEffect(() => {
    if (event) void touchEvent(event.id);
    // only on open, not on every edit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, Boolean(event)]);

  if (loading) return <AppWindow crumbs={[{ label: ROOT_CRUMB, to: "/dashboard" }]} sidebar={null}><div className="empty">Loading…</div></AppWindow>;
  if (!event) return <Navigate to="/dashboard" replace />;
  const hidden = new Set(event.hiddenFolders ?? []);
  const folders = FOLDERS.filter((folder) => {
    if (hidden.has(folder.key) && !showHidden) return false;
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return (
      folderLabel(event, folder.key).toLowerCase().includes(q) ||
      folder.noun.toLowerCase().includes(q) ||
      folder.aliases.some((a) => a.includes(q))
    );
  });

  return (
    <AppWindow
      crumbs={[{ label: ROOT_CRUMB, to: "/dashboard" }, { label: event.name }]}
      sidebar={null}
      actions={
        <>
          <Tip text={EVENT_HELP.gotSomethingElse}>
            <button className="btn amber" onClick={() => setAsking(true)}>
              <Plus size={15} strokeWidth={2.4} /> Got Something Else?
            </button>
          </Tip>
          <Tip text={EVENT_HELP.editReadme}>
            <button className="btn" onClick={() => setEditing(true)}>
              <Pencil size={13} /> Edit README
            </button>
          </Tip>
        </>
      }
      search={{ value: filter, onChange: setFilter, placeholder: "Search folders" }}
      status={`${folders.length} folder${folders.length === 1 ? "" : "s"}`}
    >
      <div className="content">
        <section className="readme">
          <header>
            <BookOpen size={14} /> README
          </header>
          <div className="body">
            <h1>{event.name}</h1>
            {event.description && <p>{event.description}</p>}
            <ul>
              {event.date && (
                <li>
                  <b>Event date:</b> {event.date}
                </li>
              )}
              {event.targets && (
                <li>
                  <b>Targets:</b> {event.targets}
                </li>
              )}
            </ul>
            {!event.description && !event.date && !event.targets && <p className="hint-line">Add a description, date and targets with Edit README.</p>}
          </div>
        </section>
        <ReadmeNote />

        <div className="label-muted">Folders</div>
        <div className="folders">
          {folders.map((folder) => (
            <JobFolder key={folder.key} event={event} folder={folder.key} hidden={hidden.has(folder.key)} />
          ))}
          <button className="folder new" onClick={() => setAsking(true)}>
            <NewFolderIcon />
            <span className="name">Got Something Else?</span>
          </button>
        </div>
        {hidden.size > 0 && (
          <button className="hidden-folders-toggle" onClick={() => setShowHidden((current) => !current)} title={EVENT_HELP.showHidden}>
            {showHidden ? "Hide the hidden folders again" : `Show ${hidden.size} hidden folder${hidden.size === 1 ? "" : "s"}`}
          </button>
        )}
      </div>

      {editing && (
        <EventSheet
          title="Edit README"
          submitLabel="Save"
          initial={event}
          onCancel={() => setEditing(false)}
          onSubmit={async (values) => {
            if (await updateEvent(event.id, values)) setEditing(false);
          }}
        />
      )}
      {(asking || ask) && (
        <NewQuerySheet
          event={event}
          initialQuery={ask || undefined}
          onClose={() => {
            setAsking(false);
            if (ask) setParams({}, { replace: true });
          }}
        />
      )}
    </AppWindow>
  );
}

const README_NOTE_KEY = "dig-readme-note-open";

/** A quiet, collapsible note on what the README is for. Remembers whether you closed it. */
function ReadmeNote() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(README_NOTE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  return (
    <details
      className="readme-note"
      open={open}
      onToggle={(toggle) => {
        const next = (toggle.currentTarget as HTMLDetailsElement).open;
        setOpen(next);
        try {
          localStorage.setItem(README_NOTE_KEY, next ? "1" : "0");
        } catch {
          // Remembering is a convenience only.
        }
      }}
    >
      <summary>Why a README?</summary>
      <p>
        It's your event's plan in one place: dates, targets and deadlines, like "start cold emails by November" or "dates
        moved to Nov 20", so the whole team stays in sync.
      </p>
      <p>Dig also uses it when it drafts a pitch, so a clear README means better emails.</p>
    </details>
  );
}

function JobFolder({ event, folder, hidden }: { event: DigEvent; folder: FolderKey; hidden: boolean }) {
  const navigate = useNavigate();
  const linked = event.jobs[folder];
  const others = (event.hiddenFolders ?? []).filter((key) => key !== folder);
  return (
    <div className={hidden ? "folder-hidden" : undefined}>
    <Tip text={hidden ? `Hidden from this event. ${EVENT_HELP.folder}` : EVENT_HELP.folder}>
    <FolderTile
      to={`/events/${event.id}/${folder}`}
      name={folderLabel(event, folder)}
      onRename={(name) => void renameFolder(event.id, folder, name)}
      menu={[
        { label: "Open", onClick: () => navigate(`/events/${event.id}/${folder}`) },
        ...(linked ? [{ label: "Remove search from folder", onClick: () => void unlinkJob(event.id, folder) }] : []),
        hidden
          ? { label: "Show folder", onClick: () => void updateEvent(event.id, { hiddenFolders: others }) }
          : { label: "Hide folder", onClick: () => void updateEvent(event.id, { hiddenFolders: [...others, folder] }) },
      ]}
    />
    </Tip>
    </div>
  );
}

interface Preview {
  intent: string;
  label: string;
  supported: boolean;
  folder: FolderKey | null;
  method: "llm" | "keyword";
  entities: { subject?: string | null; location?: string | null };
  name: string;
}

/**
 * Reads the question as you type (the API asks the LLM which kind of search it is), then creates the search,
 * files it in the matching folder of this event, starts it and opens its Job Board.
 */
export function NewQuerySheet({ event, onClose, initialQuery }: { event: DigEvent; onClose: () => void; initialQuery?: string }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState(initialQuery ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ query: string; result: Preview } | null>(null);
  const [checking, setChecking] = useState(false);
  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < 4) return;
    let stale = false;
    setChecking(true);
    const timer = window.setTimeout(() => {
      api<Preview>("/api/blueprints/preview", { method: "POST", body: JSON.stringify({ query: trimmed }) })
        .then((result) => !stale && setPreview({ query: trimmed, result }))
        .catch(() => undefined) // the submit call reports real errors
        .finally(() => !stale && setChecking(false));
    }, 450);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [trimmed]);

  const current = preview?.query === trimmed ? preview.result : null;
  const unsupported = current && !current.supported;
  const replacing = current?.folder && event.jobs[current.folder] ? folderLabel(event, current.folder) : null;

  const submit = async (form: FormEvent) => {
    form.preventDefault();
    if (unsupported || trimmed.length < 4) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ job: JobSummary; folder: FolderKey; event: DigEvent }>(`/api/events/${event.id}/searches`, {
        method: "POST",
        body: JSON.stringify({ query: trimmed }),
      });
      eventStored(result.event);
      navigate(`/events/${event.id}/${result.folder}?board=1`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "UNSUPPORTED_INTENT") setError(caught.message);
      else setError(caught instanceof Error ? caught.message : "Could not start the search.");
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onClick={onClose}>
      <form className="sheet" onSubmit={submit} onClick={(click) => click.stopPropagation()}>
        <h3>Got Something Else?</h3>
        <p className="hint">
          Ask in your own words. Dig works out what you’re looking for, searches the live web, keeps only facts it can quote from a
          source page, and files the results under this event.
        </p>
        <label>What should Dig find?</label>
        <textarea
          rows={3}
          value={query}
          onChange={(change) => setQuery(change.target.value)}
          placeholder="e.g. Find sponsors for hackathons in India, or keynote speakers, or developer APIs offering credits..."
          autoFocus
        />
        <div className="examples">
          {FOLDERS.map((folder) => (
            <button type="button" key={folder.key} onClick={() => setQuery(folder.example)}>
              {folder.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setQuery("Keynote speakers and tech experts for our hackathon in India")}
          >
            Speakers
          </button>
          <button
            type="button"
            style={{ borderColor: "rgba(76, 111, 255, 0.4)", color: "#4c6fff", fontWeight: 600 }}
            onClick={() => setQuery("Developer tool APIs and cloud platforms offering student credits and perks")}
          >
            ✨ Got something else?
          </button>
        </div>
        {trimmed.length >= 4 && (
          <div className={`notice${current && !unsupported ? " ok" : ""}`} role="status">
            {!current ? (
              checking ? "Reading your question…" : "Keep typing…"
            ) : unsupported ? (
              <>
                <b>That search isn’t supported yet.</b> It reads as a {current.label.toLowerCase()}. Dig can research hackathons &amp; events,
                research papers, sponsors, judges, mentors &amp; researchers, jobs, leads and competitors right now.
              </>
            ) : (
              <>
                <b>{current.label}</b>
                {current.entities.subject ? ` · ${current.entities.subject}` : ""}
                {current.entities.location ? ` · ${current.entities.location}` : ""} → files into{" "}
                <b>{folderLabel(event, current.folder!)}</b>
                {replacing ? ` (replaces the search there now — it stays in your profile’s recent searches)` : ""}.
              </>
            )}
          </div>
        )}
        {error && <p className="err">{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn blue" disabled={busy || Boolean(unsupported) || trimmed.length < 4}>
            {busy ? "Starting…" : "Start digging"}
          </button>
        </div>
      </form>
    </div>
  );
}
