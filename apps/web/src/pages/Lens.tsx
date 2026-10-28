import { useQuery } from "@tanstack/react-query";
import { FileDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, datasetChoices, type Dataset, type Diff, type JobSummary } from "../api";
import { AppWindow } from "../components/Shell";
import { ROOT_CRUMB } from "../events";
import { LensPlot, plotKind } from "./lens-charts";
import { buildLens, type LensSection } from "./lens-insights";
import { downloadLensReport } from "./lens-report";

const KIND: Record<string, string> = {
  SPONSOR_LOOKUP: "Sponsors",
  JUDGE_LOOKUP: "Judges, mentors and researchers",
  JOB_LOOKUP: "Jobs",
  LEAD_LOOKUP: "Leads",
  COMPETITOR_LOOKUP: "Competitors",
  EVENT_LOOKUP: "Hackathons and events",
  PAPER_LOOKUP: "Research papers",
};

/** Lens: a few useful insights for one list, chosen for its kind (sponsors, judges, jobs, leads, competitors). */
export function Lens() {
  const [params, setParams] = useSearchParams();
  const jobId = params.get("job") ?? "";
  const [saving, setSaving] = useState(false);

  const jobsQ = useQuery({ queryKey: ["jobs"], queryFn: () => api<{ jobs: JobSummary[] }>("/api/jobs") });
  const ready = useMemo(() => (jobsQ.data?.jobs ?? []).filter((job) => job.versionNumber != null), [jobsQ.data]);
  const choices = useMemo(() => datasetChoices(ready), [ready]);
  const job = ready.find((item) => item.id === jobId);

  useEffect(() => {
    if (!jobId && choices[0]) setParams({ job: choices[0].id }, { replace: true });
  }, [jobId, choices, setParams]);

  const datasetQ = useQuery({ queryKey: ["dataset", jobId], queryFn: () => api<Dataset>(`/api/jobs/${jobId}/dataset`), enabled: Boolean(jobId) });
  const diffQ = useQuery({ queryKey: ["diff", jobId], queryFn: () => api<{ diff: Diff | null }>(`/api/jobs/${jobId}/diff`), enabled: Boolean(jobId) });
  const outreachQ = useQuery({
    queryKey: ["outreach", jobId],
    queryFn: () => api<{ outreach: Record<string, { status: string; note: string }> }>(`/api/jobs/${jobId}/outreach`),
    enabled: Boolean(jobId),
  });

  const intent = job?.blueprint.intent ?? "";
  const view = useMemo(
    () =>
      datasetQ.data
        ? buildLens({ intent, records: datasetQ.data.records, outreach: outreachQ.data?.outreach ?? {}, diff: diffQ.data?.diff ?? null })
        : null,
    [intent, datasetQ.data, outreachQ.data, diffQ.data],
  );

  const download = async () => {
    if (!view || !job || saving) return;
    setSaving(true);
    try {
      await downloadLensReport({ name: job.name, kind: KIND[intent] ?? "List", query: job.query, view });
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppWindow crumbs={[{ label: ROOT_CRUMB, to: "/dashboard" }, { label: "Toolkit", to: "/agents" }, { label: "Lens" }]} sidebar="agents">
      <div className="content agent-page">
        <div className="agent-toolbar flat">
          <select aria-label="List" value={jobId} onChange={(event) => setParams(event.target.value ? { job: event.target.value } : {})}>
            {choices.length === 0 && <option value="">No lists with results yet</option>}
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
          <button className="btn" type="button" disabled={!view || saving} onClick={() => void download()}>
            <FileDown size={14} style={{ marginRight: 6, display: "inline", verticalAlign: "middle" }} />
            {saving ? "Preparing PDF…" : "Download PDF"}
          </button>
        </div>

        {!job ? (
          <p className="lens2-empty">{jobsQ.isLoading ? "Loading…" : "Run a search first. Lens summarizes a list once it has results."}</p>
        ) : !view ? (
          <p className="lens2-empty">Loading {job.name}…</p>
        ) : (
          <div className="lens2">
            <header className="lens2-head">
              <div>
                <div className="lens2-kind">{KIND[intent] ?? "List"}</div>
                <h2>{job.name}</h2>
                <Link to={`/jobs/${job.id}`} className="lens2-open">Open the list</Link>
              </div>
              <dl className="lens2-stats">
                {view.stats.map((stat) => (
                  <div key={stat.label}>
                    <dt>{stat.label}</dt>
                    <dd>{stat.value}</dd>
                  </div>
                ))}
              </dl>
            </header>

            <div className="lens2-grid">
              {view.sections.map((section) => (
                <InsightCard key={section.id} section={section} />
              ))}
              {view.sources.length > 0 && (
                <section className="lens2-card lens2-card-wide">
                  <h3>Where the rows were found</h3>
                  <p className="lens2-takeaway">Each bar is how many rows cite that site. Hover a bar for its share of this list.</p>
                  <LensPlot bars={view.sources} kind="bar" title="Sources" />
                </section>
              )}
            </div>
          </div>
        )}
      </div>
    </AppWindow>
  );
}

function InsightCard({ section }: { section: LensSection }) {
  const kind = section.bars ? plotKind(section.chart, section.bars) : null;
  const wide = Boolean(section.names?.length && section.bars?.length);
  return (
    <section className={wide ? "lens2-card lens2-card-wide" : "lens2-card"}>
      <h3>{section.title}</h3>
      <p className="lens2-takeaway">{section.takeaway}</p>
      {kind && section.bars && <LensPlot bars={section.bars} kind={kind} title={section.title} />}
      {section.names && section.names.length > 0 && (
        <ul className="lens2-names">
          {section.names.map((item, index) => (
            <li key={`${item.name}-${index}`}>
              <span className="lens2-name">{item.name}</span>
              {item.detail && <span className="lens2-detail">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
