import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { Conflict, DatasetRecord } from "../api";

export interface DatasetPdfInput {
  jobName: string;
  query: string;
  intent: string;
  versionNumber: number;
  createdAt: string;
  qualityScore: number | null;
  avgConfidence: number | null;
  records: DatasetRecord[];
  conflicts: Conflict[];
  outreach: Record<string, { status: string; note?: string }>;
}

// Black and white only: ink for text, grey for secondary text and rules.
const INK: [number, number, number] = [0, 0, 0];
const GREY: [number, number, number] = [95, 95, 95];
const RULE: [number, number, number] = [200, 200, 200];

const OUTREACH_LABEL: Record<string, string> = {
  pending: "Not contacted",
  waiting: "Waiting",
  interested: "Interested",
  declined: "Declined",
};

function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";
}

function dateOf(value: string) {
  const date = new Date(value || Date.now());
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** "https://www.linkedin.com/in/alex-k" → "linkedin.com/in/alex-k" */
function shortUrl(url: string | undefined) {
  return url ? url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "") : "";
}

function nameOf(record: DatasetRecord) {
  return (
    record.fields.paper_title ||
    record.fields.event_name ||
    record.fields.person_name ||
    record.fields.company_name ||
    record.fields.role_title ||
    record.label ||
    ""
  );
}

/** The second column: who they are and what they do, from whichever fields this search type has. */
function detailOf(record: DatasetRecord) {
  const f = record.fields;
  const parts = f.paper_title
    ? [f.authors, f.venue, f.year, f.topic]
    : f.event_name && (f.prize_pool || f.dates || f.organizer)
      ? [f.organizer, f.dates, f.location, f.prize_pool]
      : f.person_name
        ? [f.affiliation, f.expertise, f.event_name]
        : f.role_title
          ? [f.company_name, f.location, f.workplace]
          : [f.category, f.sponsorship_type, f.event_name, f.contact];
  return parts.filter((part) => part?.trim()).join(" · ");
}

/** A real address only: older runs could hold a bare domain in the email field. */
function emailOf(record: DatasetRecord) {
  const value = (record.fields.email || record.contactability?.channels?.email?.value || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : "";
}

function isReachable(record: DatasetRecord) {
  const phone = record.fields.phone || record.contactability?.channels?.phone?.value;
  return Boolean(emailOf(record) || phone?.trim() || record.fields.linkedin?.trim());
}

export async function downloadDatasetPdf(input: DatasetPdfInput) {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape", compress: true });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 16;
  const contentWidth = pageWidth - margin * 2;
  doc.setProperties({ title: input.jobName, subject: input.query, creator: "Dig" });

  const records = [...input.records].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const reachable = records.filter(isReachable).length;
  const contacted = records.filter((record) => (input.outreach[record.canonicalEntityId]?.status ?? "pending") !== "pending").length;
  const sourceUrls = new Map<string, string>();
  for (const record of records) for (const source of record.sources ?? []) if (!sourceUrls.has(source.url)) sourceUrls.set(source.url, source.title);

  // Title block
  let y = margin + 4;
  doc.setTextColor(...INK);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(doc.splitTextToSize(input.jobName, contentWidth)[0] ?? input.jobName, margin, y);

  y += 6.5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(...GREY);
  const queryLines = doc.splitTextToSize(`Query: ${input.query}`, contentWidth) as string[];
  doc.text(queryLines, margin, y);
  y += queryLines.length * 4.4;

  doc.text(
    `Version ${input.versionNumber}  ·  ${dateOf(input.createdAt)}  ·  ${records.length} records  ·  ${sourceUrls.size} sources  ·  ` +
      `${reachable} reachable  ·  ${contacted} contacted`,
    margin,
    y,
  );

  y += 4;
  doc.setDrawColor(...INK);
  doc.setLineWidth(0.3);
  doc.line(margin, y, pageWidth - margin, y);

  y += 6;
  doc.setFontSize(8.5);
  const method =
    "Every value in this report was copied from a public web page, and each row lists how many pages support it. " +
    "Rows are ordered by how many details were found. Contact paths marked here were matched to the person or company by name and organization.";
  const methodLines = doc.splitTextToSize(method, contentWidth) as string[];
  doc.text(methodLines, margin, y);
  y += methodLines.length * 3.8 + 3;

  // Main table
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin, top: margin, bottom: 16 },
    head: [["#", "Name", "Details", "Email", "Phone", "LinkedIn", "Outreach", "Sources"]],
    body: records.map((record, index) => [
      String(record.rank ?? index + 1),
      nameOf(record),
      detailOf(record),
      emailOf(record),
      record.fields.phone || record.contactability?.channels?.phone?.value || "",
      shortUrl(record.fields.linkedin),
      OUTREACH_LABEL[input.outreach[record.canonicalEntityId]?.status ?? "pending"] ?? "Not contacted",
      String(record.sourceCount ?? record.sources?.length ?? 0),
    ]),
    theme: "plain",
    styles: { font: "helvetica", fontSize: 8, textColor: INK, cellPadding: { top: 2, bottom: 2, left: 1.5, right: 1.5 }, overflow: "linebreak", valign: "top" },
    headStyles: { fontStyle: "bold", textColor: INK, lineWidth: { bottom: 0.3 }, lineColor: INK },
    bodyStyles: { lineWidth: { bottom: 0.1 }, lineColor: RULE },
    columnStyles: {
      0: { cellWidth: 8, textColor: GREY },
      1: { cellWidth: 42, fontStyle: "bold" },
      2: { cellWidth: 72 },
      3: { cellWidth: 44 },
      4: { cellWidth: 24 },
      5: { cellWidth: 40 },
      6: { cellWidth: 20 },
      7: { cellWidth: 15, halign: "right" },
    },
  });

  let after = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y;

  const section = (title: string) => {
    if (after > pageHeight - 40) {
      doc.addPage();
      after = margin;
    } else {
      after += 10;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(...INK);
    doc.text(title, margin, after);
    after += 2;
  };

  // Changes found on re-run
  if (input.conflicts.length > 0) {
    section("Changes found on re-run");
    autoTable(doc, {
      startY: after + 1,
      margin: { left: margin, right: margin, top: margin, bottom: 16 },
      head: [["Field", "Previous value", "New value", "Outcome"]],
      body: input.conflicts.map((conflict) => [
        conflict.field.replace(/_/g, " "),
        conflict.oldValue || "",
        conflict.newValue || "",
        conflict.status === "PENDING" ? "Awaiting review" : conflict.status === "AUTO_RESOLVED" ? "Resolved automatically" : "Resolved by reviewer",
      ]),
      theme: "plain",
      styles: { font: "helvetica", fontSize: 8, textColor: INK, cellPadding: { top: 1.8, bottom: 1.8, left: 1.5, right: 1.5 }, overflow: "linebreak" },
      headStyles: { fontStyle: "bold", lineWidth: { bottom: 0.3 }, lineColor: INK },
      bodyStyles: { lineWidth: { bottom: 0.1 }, lineColor: RULE },
      columnStyles: { 0: { cellWidth: 36 }, 1: { cellWidth: 90 }, 2: { cellWidth: 90 } },
    });
    after = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? after;
  }

  // Sources
  if (sourceUrls.size > 0) {
    section("Sources");
    autoTable(doc, {
      startY: after + 1,
      margin: { left: margin, right: margin, top: margin, bottom: 16 },
      body: [...sourceUrls].map(([url, title], index) => [String(index + 1), title || shortUrl(url), shortUrl(url)]),
      theme: "plain",
      styles: { font: "helvetica", fontSize: 7.5, textColor: INK, cellPadding: { top: 1.2, bottom: 1.2, left: 1.5, right: 1.5 }, overflow: "linebreak" },
      columnStyles: { 0: { cellWidth: 8, textColor: GREY }, 1: { cellWidth: 110 }, 2: { textColor: GREY } },
    });
  }

  // Footer on every page, with the total page count
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.1);
    doc.line(margin, pageHeight - 10, pageWidth - margin, pageHeight - 10);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...GREY);
    doc.text(`Dig  ·  ${input.jobName}`, margin, pageHeight - 6);
    const label = `Page ${page} of ${pages}`;
    doc.text(label, pageWidth - margin - doc.getTextWidth(label), pageHeight - 6);
  }

  doc.save(`dig-${slug(input.jobName)}-v${input.versionNumber}.pdf`);
}
