import { useQueries, useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Layers,
  Mail,
  RotateCw,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OutreachStatus } from "@dig/schemas";
import { api, download, type Dataset, type DatasetRecord, type JobSummary } from "../api";
import { AppWindow } from "../components/Shell";
import { ROOT_CRUMB } from "../events";
import { notify, notifyError } from "../toast";
import { CompanyLogo } from "./JobBoard";

/** Furthest along wins when a merged row has marks in several searches. */
const OUTREACH_ORDER: OutreachStatus[] = ["pending", "declined", "waiting", "interested"];

interface MergedRecord {
  id: string;
  canonicalEntityId: string;
  name: string;
  category: string;
  contact: string;
  email: string;
  phone: string;
  website: string;
  confidence: number;
  status: string;
  origins: Array<{ id: string; name: string; intent: string }>;
  rawRecord: DatasetRecord;
}

const INTENT_BADGES: Record<string, { label: string; color: string }> = {
  SPONSOR_LOOKUP: { label: "Sponsors", color: "#4c6fff" },
  JUDGE_LOOKUP: { label: "Judges", color: "#8a3ffc" },
  LEAD_LOOKUP: { label: "Leads", color: "#007acc" },
  JOB_LOOKUP: { label: "Jobs", color: "#248a3d" },
  COMPETITOR_LOOKUP: { label: "Competitors", color: "#b86e00" },
  EVENT_LOOKUP: { label: "Hackathons", color: "#d97706" },
  PAPER_LOOKUP: { label: "Papers", color: "#7c3aed" },
};

export function Merger() {
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set());
  const [intentFilter, setIntentFilter] = useState<string>("all");
  const [dedupe, setDedupe] = useState<boolean>(true);
  const [search, setSearch] = useState<string>("");
  const [isDatasetsOpen, setIsDatasetsOpen] = useState<boolean>(true);
  const [previewTab, setPreviewTab] = useState<"all" | "contacted" | OutreachStatus>("all");
  const [selectedRow, setSelectedRow] = useState<MergedRecord | null>(null);
  const [copiedTsv, setCopiedTsv] = useState<boolean>(false);
  const [copiedEmailId, setCopiedEmailId] = useState<string | null>(null);
  const [busyExport, setBusyExport] = useState<string | null>(null);

  // Fetch all user jobs
  const jobsQ = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<{ jobs: JobSummary[] }>("/api/jobs"),
  });

  const readyJobs = useMemo(() => {
    return (jobsQ.data?.jobs ?? []).filter((j) => j.versionNumber != null && j.rowCount > 0);
  }, [jobsQ.data]);

  // Pre-select first 3 jobs by default on initial load
  useEffect(() => {
    if (readyJobs.length > 0 && selectedJobIds.size === 0) {
      const initial = new Set(readyJobs.slice(0, Math.min(3, readyJobs.length)).map((j) => j.id));
      setSelectedJobIds(initial);
    }
  }, [readyJobs, selectedJobIds.size]);

  // Filter ready jobs by intent
  const visibleJobs = useMemo(() => {
    if (intentFilter === "all") return readyJobs;
    return readyJobs.filter((j) => j.blueprint.intent === intentFilter);
  }, [readyJobs, intentFilter]);

  // Parallel fetch datasets for selected jobs
  const datasetQueries = useQueries({
    queries: Array.from(selectedJobIds).map((jobId) => ({
      queryKey: ["dataset", jobId],
      queryFn: () => api<Dataset>(`/api/jobs/${jobId}/dataset`),
      staleTime: 60_000,
    })),
  });

  const outreachQueries = useQueries({
    queries: Array.from(selectedJobIds).map((jobId) => ({
      queryKey: ["outreach", jobId],
      queryFn: () => api<{ outreach: Record<string, { status: OutreachStatus; note: string }> }>(`/api/jobs/${jobId}/outreach`),
      staleTime: 30_000,
    })),
  });
  const outreachByJob = useMemo(() => {
    const ids = Array.from(selectedJobIds);
    const map = new Map<string, Record<string, { status: OutreachStatus; note: string }>>();
    outreachQueries.forEach((query, index) => {
      const id = ids[index];
      if (id && query.data) map.set(id, query.data.outreach);
    });
    return map;
  }, [outreachQueries, selectedJobIds]);

  const isLoadingDatasets = datasetQueries.some((q) => q.isLoading);

  // Map of jobId -> job
  const jobMap = useMemo(() => {
    const map = new Map<string, JobSummary>();
    for (const j of readyJobs) map.set(j.id, j);
    return map;
  }, [readyJobs]);

  // Merge and deduplicate records
  const { allMergedRecords, totalRawCount } = useMemo(() => {
    const rawList: Array<{ record: DatasetRecord; job: JobSummary }> = [];
    const selectedIdsArray = Array.from(selectedJobIds);

    datasetQueries.forEach((q, idx) => {
      const jobId = selectedIdsArray[idx];
      const job = jobId ? jobMap.get(jobId) : undefined;
      if (job && q.data?.records) {
        for (const rec of q.data.records) {
          rawList.push({ record: rec, job });
        }
      }
    });

    const totalRaw = rawList.length;

    if (!dedupe) {
      // Raw append mode
      const result: MergedRecord[] = rawList.map(({ record, job }, index) => {
        const f = record.fields;
        const name = f.company_name || f.person_name || f.role_title || `Record ${index + 1}`;
        return {
          id: `${job.id}-${record.id}-${index}`,
          canonicalEntityId: record.canonicalEntityId || record.id,
          name,
          category: f.category || f.sponsorship_type || f.expertise || f.location || f.workplace || "",
          contact: f.contact || f.person_name || "",
          email: f.email || record.contactability?.channels?.email?.value || "",
          phone: f.phone || record.contactability?.channels?.phone?.value || "",
          website: f.website || record.contactability?.channels?.website?.value || "",
          confidence: record.confidence ?? 0.8,
          status: record.status,
          origins: [{ id: job.id, name: job.name, intent: job.blueprint.intent }],
          rawRecord: record,
        };
      });
      return { allMergedRecords: result, totalRawCount: totalRaw };
    }

    // Smart deduplication mode
    const entityMap = new Map<
      string,
      {
        canonicalKey: string;
        name: string;
        category: string;
        contact: string;
        email: string;
        phone: string;
        website: string;
        maxConfidence: number;
        status: string;
        originsMap: Map<string, { id: string; name: string; intent: string }>;
        primaryRecord: DatasetRecord;
      }
    >();

    for (const { record, job } of rawList) {
      const f = record.fields;
      const primaryName = (f.company_name || f.person_name || f.role_title || "").trim();
      const normKey =
        record.canonicalEntityId ||
        primaryName.toLowerCase().replace(/[^a-z0-9]/g, "") ||
        `unknown-${record.id}`;

      const existing = entityMap.get(normKey);
      if (existing) {
        existing.originsMap.set(job.id, { id: job.id, name: job.name, intent: job.blueprint.intent });
        existing.maxConfidence = Math.max(existing.maxConfidence, record.confidence ?? 0.8);
        if (!existing.email && (f.email || record.contactability?.channels?.email?.value)) {
          existing.email = f.email || record.contactability?.channels?.email?.value || "";
        }
        if (!existing.phone && (f.phone || record.contactability?.channels?.phone?.value)) {
          existing.phone = f.phone || record.contactability?.channels?.phone?.value || "";
        }
        if (!existing.website && (f.website || record.contactability?.channels?.website?.value)) {
          existing.website = f.website || record.contactability?.channels?.website?.value || "";
        }
        if (!existing.contact && (f.contact || f.person_name)) {
          existing.contact = f.contact || f.person_name || "";
        }
        if (!existing.category && (f.category || f.sponsorship_type || f.expertise || f.location)) {
          existing.category = f.category || f.sponsorship_type || f.expertise || f.location || "";
        }
      } else {
        const originsMap = new Map<string, { id: string; name: string; intent: string }>();
        originsMap.set(job.id, { id: job.id, name: job.name, intent: job.blueprint.intent });
        entityMap.set(normKey, {
          canonicalKey: normKey,
          name: primaryName || "Unknown Entity",
          category: f.category || f.sponsorship_type || f.expertise || f.location || f.workplace || "",
          contact: f.contact || f.person_name || "",
          email: f.email || record.contactability?.channels?.email?.value || "",
          phone: f.phone || record.contactability?.channels?.phone?.value || "",
          website: f.website || record.contactability?.channels?.website?.value || "",
          maxConfidence: record.confidence ?? 0.8,
          status: record.status,
          originsMap,
          primaryRecord: record,
        });
      }
    }

    const mergedList: MergedRecord[] = Array.from(entityMap.entries())
      .sort((a, b) => b[1].maxConfidence - a[1].maxConfidence)
      .map(([key, item]) => ({
        id: key,
        canonicalEntityId: key,
        name: item.name,
        category: item.category,
        contact: item.contact,
        email: item.email,
        phone: item.phone,
        website: item.website,
        confidence: item.maxConfidence,
        status: item.status,
        origins: Array.from(item.originsMap.values()),
        rawRecord: item.primaryRecord,
      }));

    return { allMergedRecords: mergedList, totalRawCount: totalRaw };
  }, [datasetQueries, dedupe, jobMap, selectedJobIds]);

  // Computed metrics
  const uniqueCount = allMergedRecords.length;
  const duplicatesResolved = Math.max(0, totalRawCount - uniqueCount);
  /** One status per merged row: the furthest along across the searches it came from. */
  const outreachOf = (record: MergedRecord): OutreachStatus => {
    let best: OutreachStatus = "pending";
    for (const origin of record.origins) {
      const status = outreachByJob.get(origin.id)?.[record.canonicalEntityId]?.status ?? "pending";
      if (OUTREACH_ORDER.indexOf(status) > OUTREACH_ORDER.indexOf(best)) best = status;
    }
    return best;
  };
  const outreachCounts = useMemo(() => {
    const counts: Record<OutreachStatus, number> = { pending: 0, waiting: 0, interested: 0, declined: 0 };
    for (const record of allMergedRecords) counts[outreachOf(record)] += 1;
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allMergedRecords, outreachByJob]);
  const contactedCount = allMergedRecords.length - outreachCounts.pending;

  // Filter merged records by search query and active tab
  const filteredRecords = useMemo(() => {
    let list = allMergedRecords;
    if (previewTab === "contacted") {
      list = list.filter((r) => outreachOf(r) !== "pending");
    } else if (previewTab !== "all") {
      list = list.filter((r) => outreachOf(r) === previewTab);
    }

    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => {
      return (
        r.name.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q) ||
        r.contact.toLowerCase().includes(q) ||
        r.origins.some((o) => o.name.toLowerCase().includes(q))
      );
    });
  }, [allMergedRecords, previewTab, search]);

  // Toggle selection
  const toggleJob = (id: string) => {
    setSelectedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedJobIds(new Set(visibleJobs.map((j) => j.id)));
  };

  const deselectAll = () => {
    setSelectedJobIds(new Set());
  };

  // Export handlers
  const exportExcel = async () => {
    if (selectedJobIds.size === 0) return;
    setBusyExport("xlsx");
    try {
      const jobIdsParam = Array.from(selectedJobIds).join(",");
      await download(
        `/api/agents/merge/export?jobs=${encodeURIComponent(jobIdsParam)}&format=xlsx&dedupe=${dedupe}`,
        `dig-merged-${filteredRecords.length}-records.xlsx`,
      );
      notify(`Exported ${filteredRecords.length} records to Excel (.xlsx)`, "info");
    } catch (err) {
      notifyError(err);
    } finally {
      setBusyExport(null);
    }
  };

  const exportCsv = () => {
    if (filteredRecords.length === 0) return;
    const headers = ["Rank", "Entity", "Category", "Contact", "Email", "Phone", "Website", "Confidence", "Status", "Origin Datasets"];
    const rows = filteredRecords.map((r, i) =>
      [
        i + 1,
        JSON.stringify(r.name),
        JSON.stringify(r.category),
        JSON.stringify(r.contact),
        JSON.stringify(r.email),
        JSON.stringify(r.phone),
        JSON.stringify(r.website),
        `${Math.round(r.confidence * 100)}%`,
        JSON.stringify(r.status),
        JSON.stringify(r.origins.map((o) => o.name).join(", ")),
      ].join(","),
    );

    const blob = new Blob([[headers.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `dig-merged-${filteredRecords.length}-records.csv`;
    link.click();
    URL.revokeObjectURL(url);
    notify(`Exported ${filteredRecords.length} records to CSV`, "info");
  };

  const exportJson = () => {
    if (filteredRecords.length === 0) return;
    const data = filteredRecords.map((r, i) => ({
      rank: i + 1,
      canonicalId: r.canonicalEntityId,
      name: r.name,
      category: r.category,
      contact: r.contact,
      email: r.email,
      phone: r.phone,
      website: r.website,
      confidence: Math.round(r.confidence * 100) / 100,
      status: r.status,
      origins: r.origins,
    }));

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `dig-merged-${filteredRecords.length}-records.json`;
    link.click();
    URL.revokeObjectURL(url);
    notify(`Exported ${filteredRecords.length} records to JSON`, "info");
  };

  const copyTsv = () => {
    if (filteredRecords.length === 0) return;
    const headers = ["Rank", "Entity", "Category", "Contact", "Email", "Phone", "Website", "Confidence", "Status", "Origin Datasets"];
    const rows = filteredRecords.map((r, i) =>
      [
        i + 1,
        r.name,
        r.category,
        r.contact,
        r.email,
        r.phone,
        r.website,
        `${Math.round(r.confidence * 100)}%`,
        r.status,
        r.origins.map((o) => o.name).join(", "),
      ].join("\t"),
    );

    const tsv = [headers.join("\t"), ...rows].join("\n");
    void navigator.clipboard.writeText(tsv);
    setCopiedTsv(true);
    notify(`Copied ${filteredRecords.length} rows (pasteable directly into Google Sheets or Excel)`, "info");
    setTimeout(() => setCopiedTsv(false), 2000);
  };

  const copyEmail = (email: string, id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(email);
    setCopiedEmailId(id);
    setTimeout(() => setCopiedEmailId(null), 1500);
  };

  return (
    <AppWindow
      crumbs={[{ label: ROOT_CRUMB, to: "/dashboard" }, { label: "Toolkit", to: "/agents" }, { label: "Merger" }]}
      sidebar="merger"
      status={`${allMergedRecords.length} merged records from ${selectedJobIds.size} datasets`}
    >
      <div className="merger-view">
        {/* Head Bar */}
        <div className="merger-head">
          <div className="merger-title-wrap">
            <div className="merger-icon-badge">
              <Layers size={20} />
            </div>
            <div>
              <h1>Dataset Merger</h1>
              <p>Select multiple research lists across events to deduplicate and export into unified master spreadsheets.</p>
            </div>
          </div>
          <div className="merger-actions">
            <button
              className="btn merger-btn-excel"
              onClick={() => void exportExcel()}
              disabled={selectedJobIds.size === 0 || busyExport === "xlsx"}
              title="Download consolidated Excel workbook"
            >
              <FileSpreadsheet size={14} />
              {busyExport === "xlsx" ? "Generating .xlsx…" : "Export Excel (.xlsx)"}
            </button>
            <button
              className="btn"
              onClick={exportCsv}
              disabled={filteredRecords.length === 0}
              title="Download consolidated CSV"
            >
              <Download size={14} /> Export CSV
            </button>
            <button
              className="btn"
              onClick={copyTsv}
              disabled={filteredRecords.length === 0}
              title="Copy table to paste directly into Google Sheets"
            >
              {copiedTsv ? <Check size={14} color="#248a3d" /> : <Copy size={14} />}
              {copiedTsv ? "Copied Sheets TSV" : "Copy for Sheets"}
            </button>
            <button
              className="btn"
              onClick={exportJson}
              disabled={filteredRecords.length === 0}
              title="Export structured JSON"
            >
              JSON
            </button>
          </div>
        </div>

        {/* Dataset Selection Section */}
        <div className="merger-section">
          <div className="merger-section-head">
            <div className="merger-section-title">
              <Database size={15} color="#4c6fff" />
              <span>Select Datasets to Combine ({selectedJobIds.size} selected)</span>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 11, padding: "2px 8px", display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 8 }}
                onClick={() => setIsDatasetsOpen((v) => !v)}
              >
                {isDatasetsOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                <span>{isDatasetsOpen ? "Collapse List" : "Expand List"}</span>
              </button>
            </div>
            {isDatasetsOpen && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {/* Intent filter */}
                <div className="seg" style={{ padding: 1 }}>
                  {(
                    [
                      ["all", "All"],
                      ["SPONSOR_LOOKUP", "Sponsors"],
                      ["JUDGE_LOOKUP", "Judges"],
                      ["LEAD_LOOKUP", "Leads"],
                      ["JOB_LOOKUP", "Jobs"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      className={intentFilter === key ? "on" : undefined}
                      onClick={() => setIntentFilter(key)}
                      style={{ fontSize: 11, padding: "3px 8px" }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button className="btn" style={{ fontSize: 11, padding: "3px 8px" }} onClick={selectAll}>
                  Select All
                </button>
                <button className="btn" style={{ fontSize: 11, padding: "3px 8px" }} onClick={deselectAll}>
                  Clear
                </button>
              </div>
            )}
          </div>

          {/* Cards Grid when open */}
          {isDatasetsOpen ? (
            <div className="merger-cards-grid">
              {visibleJobs.map((job) => {
                const isSelected = selectedJobIds.has(job.id);
                const badge = INTENT_BADGES[job.blueprint.intent] ?? { label: "Dataset", color: "var(--text-2)" };
                return (
                  <div
                    key={job.id}
                    className={`merger-card${isSelected ? " selected" : ""}`}
                    onClick={() => toggleJob(job.id)}
                  >
                    <input
                      type="checkbox"
                      className="merger-card-checkbox"
                      checked={isSelected}
                      onChange={() => {}}
                      aria-label={`Select ${job.name}`}
                    />
                    <div className="merger-card-info">
                      <div className="merger-card-name" title={job.name}>
                        {job.name}
                      </div>
                      <div className="merger-card-meta">
                        <span className="merger-intent-tag">{badge.label}</span>
                        <span><b>{job.rowCount}</b> records</span>
                        <span>·</span>
                        <span><b>{job.sourceCount}</b> sources</span>
                      </div>
                    </div>
                  </div>
                );
              })}
              {visibleJobs.length === 0 && (
                <div style={{ color: "var(--text-3)", fontSize: 12, padding: 16 }}>
                  No completed datasets match this filter. Run a search to populate datasets.
                </div>
              )}
            </div>
          ) : (
            /* Collapsed Summary Chips */
            <div className="merger-collapsed-summary">
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)", letterSpacing: "0.04em" }}>ACTIVE DATASETS:</span>
              {Array.from(selectedJobIds).map((id) => {
                const j = jobMap.get(id);
                if (!j) return null;
                return (
                  <span key={id} className="merger-active-chip">
                    <span className="dot" />
                    <b>{j.name}</b>
                    <span className="count">({j.rowCount} records)</span>
                  </span>
                );
              })}
              <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => setIsDatasetsOpen(true)}>
                Modify Sources
              </button>
            </div>
          )}
        </div>

        {/* Deduplication Controls Bar */}
        <div className="merger-config-bar">
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <label className="merger-dedupe-toggle">
              <input
                type="checkbox"
                checked={dedupe}
                onChange={(e) => setDedupe(e.target.checked)}
              />
              <span>
                <b>Merge duplicates</b>
                <small>The same company in several lists becomes one row, with its emails and phones combined.</small>
              </span>
            </label>
            {isLoadingDatasets && <div style={{ fontSize: 11, color: "var(--text-3)", marginLeft: "auto" }}>Syncing lists…</div>}
          </div>
        </div>

        {/* Live Merge Metrics */}
        <div className="merger-metrics-grid">
          <div className="merger-metric-box">
            <span className="lbl">Datasets Selected</span>
            <span className="val accent">{selectedJobIds.size}</span>
          </div>
          <div className="merger-metric-box">
            <span className="lbl">Total Input Records</span>
            <span className="val">{totalRawCount}</span>
          </div>
          <div className="merger-metric-box">
            <span className="lbl">Unique Master Entities</span>
            <span className="val success">{uniqueCount}</span>
          </div>
          <div className="merger-metric-box">
            <span className="lbl">Duplicates Resolved</span>
            <span className="val">{duplicatesResolved}</span>
          </div>
          <div className="merger-metric-box">
            <span className="lbl">Contacted</span>
            <span className="val">{contactedCount}</span>
          </div>
        </div>

        {/* Preview Data Grid Section */}
        <div className="merger-preview-section">
          <div className="merger-preview-toolbar">
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div className="seg">
                <button
                  type="button"
                  className={previewTab === "all" ? "on" : undefined}
                  onClick={() => setPreviewTab("all")}
                >
                  All <span className="n">{allMergedRecords.length}</span>
                </button>
                {(
                  [
                    ["contacted", "Contacted", contactedCount],
                    ["interested", "Interested", outreachCounts.interested],
                    ["waiting", "Waiting", outreachCounts.waiting],
                    ["declined", "Declined", outreachCounts.declined],
                    ["pending", "Not contacted", outreachCounts.pending],
                  ] as const
                ).map(([key, label, count]) => (
                  <button key={key} type="button" className={previewTab === key ? "on" : undefined} onClick={() => setPreviewTab(key)}>
                    {label} <span className="n">{count}</span>
                  </button>
                ))}
              </div>
              {isLoadingDatasets && <RotateCw size={13} className="spin" color="#4c6fff" />}
            </div>
            <label className="search" style={{ width: 260 }}>
              <Search size={14} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search merged prospects…"
              />
            </label>
          </div>

          <div className="merger-preview-split">
            <div className="merger-table-scroll">
              <table className="data-grid">
                <thead>
                  <tr>
                    <th className="n">#</th>
                    <th style={{ minWidth: 200 }}>Entity</th>
                    <th style={{ minWidth: 200 }}>Origin Datasets</th>
                    <th style={{ minWidth: 150 }}>Category / Type</th>
                    <th style={{ minWidth: 140 }}>Contact</th>
                    <th style={{ minWidth: 180 }}>Email</th>
                    <th style={{ minWidth: 120 }}>Phone</th>
                    <th style={{ minWidth: 140 }}>Website</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRecords.map((item, index) => {
                    const isCopied = copiedEmailId === item.id;
                    const isSelected = selectedRow?.id === item.id;
                    return (
                      <tr
                        key={item.id}
                        className={isSelected ? "sel" : ""}
                        onClick={() => setSelectedRow((prev) => (prev?.id === item.id ? null : item))}
                      >
                        <td className="n">{index + 1}</td>
                        <td className="co" title={item.name}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <CompanyLogo record={item.rawRecord} name={item.name} />
                            <div style={{ fontWeight: 600, color: "var(--text)" }}>{item.name}</div>
                          </div>
                        </td>
                        <td>
                          <div style={{ display: "flex", flexWrap: "wrap", maxWidth: 260 }}>
                            {item.origins.map((o) => (
                              <span key={o.id} className="origin-badge" title={`Found in: ${o.name}`}>
                                {o.name.length > 20 ? `${o.name.slice(0, 18)}…` : o.name}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td title={item.category}>{item.category || "—"}</td>
                        <td title={item.contact}>{item.contact || "—"}</td>
                        <td>
                          {item.email ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <a
                                href={`mailto:${item.email}`}
                                className="email-link"
                                title={`Email ${item.email}`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Mail size={12} style={{ opacity: 0.7 }} />
                                <span>{item.email}</span>
                              </a>
                              <button
                                className="mini-copy-btn"
                                title="Copy email"
                                onClick={(e) => copyEmail(item.email, item.id, e)}
                              >
                                {isCopied ? <Check size={11} color="#248a3d" /> : <Copy size={11} />}
                              </button>
                            </div>
                          ) : (
                            <span style={{ color: "var(--text-3)" }}>—</span>
                          )}
                        </td>
                        <td title={item.phone}>{item.phone || "—"}</td>
                        <td>
                          {item.website ? (
                            <a
                              href={item.website.startsWith("http") ? item.website : `https://${item.website}`}
                              target="_blank"
                              rel="noreferrer"
                              className="company-sub-link"
                              title={item.website}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {item.website.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}
                              <ExternalLink size={10} style={{ marginLeft: 3 }} />
                            </a>
                          ) : (
                            <span style={{ color: "var(--text-3)" }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filteredRecords.length === 0 && (
                    <tr>
                      <td colSpan={8} style={{ textAlign: "center", color: "var(--text-3)", padding: 48 }}>
                        {selectedJobIds.size === 0
                          ? "Select at least one dataset above to preview the merged records."
                          : "No records match your current tab or search filter."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Selected Row Detail Drawer */}
            {selectedRow && (
              <div className="merger-drawer">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-3)", letterSpacing: "0.05em" }}>
                    Entity Inspector
                  </span>
                  <button
                    className="btn"
                    style={{ padding: "2px 6px", fontSize: 11 }}
                    onClick={() => setSelectedRow(null)}
                    title="Close Inspector"
                  >
                    <X size={13} />
                  </button>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, paddingBottom: 10, borderBottom: "1px solid var(--hairline)" }}>
                  <CompanyLogo record={selectedRow.rawRecord} name={selectedRow.name} />
                  <div>
                    <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{selectedRow.name}</h3>
                    <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 2 }}>{selectedRow.category || "General Company"}</div>
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", marginBottom: 6 }}>CONTRIBUTING DATASETS ({selectedRow.origins.length})</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {selectedRow.origins.map((o) => (
                      <div
                        key={o.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "6px 8px",
                          borderRadius: 6,
                          background: "var(--card)",
                          border: "1px solid var(--hairline)",
                          fontSize: 12,
                        }}
                      >
                        <span style={{ fontWeight: 600, color: "var(--text)" }}>{o.name}</span>
                        <span className="merger-intent-tag" style={{ fontSize: 10 }}>{o.intent.replace("_LOOKUP", "")}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", marginBottom: 6 }}>CONTACT &amp; REACHABILITY</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
                    <div>
                      <span style={{ color: "var(--text-3)", display: "block", fontSize: 10 }}>PRIMARY CONTACT</span>
                      <span style={{ fontWeight: 600 }}>{selectedRow.contact || "No name recorded"}</span>
                    </div>
                    <div>
                      <span style={{ color: "var(--text-3)", display: "block", fontSize: 10 }}>EMAIL</span>
                      {selectedRow.email ? (
                        <a href={`mailto:${selectedRow.email}`} style={{ color: "#4c6fff", fontWeight: 600 }}>
                          {selectedRow.email}
                        </a>
                      ) : (
                        <span style={{ color: "var(--text-3)" }}>Not available</span>
                      )}
                    </div>
                    <div>
                      <span style={{ color: "var(--text-3)", display: "block", fontSize: 10 }}>PHONE</span>
                      <span>{selectedRow.phone || "Not available"}</span>
                    </div>
                    <div>
                      <span style={{ color: "var(--text-3)", display: "block", fontSize: 10 }}>WEBSITE</span>
                      {selectedRow.website ? (
                        <a
                          href={selectedRow.website.startsWith("http") ? selectedRow.website : `https://${selectedRow.website}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "#4c6fff" }}
                        >
                          {selectedRow.website}
                        </a>
                      ) : (
                        <span style={{ color: "var(--text-3)" }}>Not available</span>
                      )}
                    </div>
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", marginBottom: 6 }}>STATUS</div>
                  <div
                    style={{ fontSize: 13, color: "var(--text)" }}
                    title="Confidence: how strongly this row is sourced (source authority, number of sources, freshness)"
                  >
                    <b>{selectedRow.status === "possible_duplicate" ? "Possible duplicate" : "Verified"}</b>{" "}
                    {Math.round(selectedRow.confidence * 100)}%
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppWindow>
  );
}
