import {
  Bot,
  Briefcase,
  CheckCircle2,
  ChevronRight,
  Database,
  ExternalLink,
  Folder,
  Layers,
  Maximize2,
  Minimize2,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  User,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type DatasetRecord, type JobSummary } from "../api";
import { FOLDERS, folderLabel, useEvents, type DigEvent, type FolderKey } from "../events";
import { useSession } from "../session";
import { GUIDE_URL } from "./Marketing";
import { Tip } from "./Tip";

// ---------------------------------------------------------------------------
// 1. Comprehensive Platform Knowledge Base (RAG Documents)
// ---------------------------------------------------------------------------
export interface KnowledgeDoc {
  id: string;
  category: "philosophy" | "archetypes" | "veracity" | "outreach" | "workflows" | "payments" | "metering" | "exports" | "general";
  title: string;
  keys: string[];
  summary: string;
  bullets: string[];
  actionLink?: { label: string; to: string };
}

export const KNOWLEDGE_BASE: KnowledgeDoc[] = [
  {
    id: "sourced-not-guessed",
    category: "philosophy",
    title: "Why every value is sourced, and why some rows have no email",
    keys: [
      "veracity", "confidence", "hallucinat", "why no email", "missing email", "no contact", "guess email",
      "fake email", "pattern", "evidence", "proof", "accuracy", "grounded", "real data", "source", "trust",
    ],
    summary:
      "Dig only shows what it can copy word for word from a real web page, and every value links back to that page. It never guesses an email like first.last@company.com, because guessed addresses bounce and hurt your reputation. If no page lists an email, the row says so instead of inventing one.",
    bullets: [
      "Click any row to open its side panel and see the exact pages behind each value.",
      "The % next to Verified is the confidence: more pages, more official pages and newer pages score higher.",
      "No email? Check the LinkedIn column, or use Another to find a different person at the company.",
    ],
    actionLink: { label: "Why Dig works this way", to: "/why-dig" },
  },
  {
    id: "search-types",
    category: "archetypes",
    title: "What Dig can find",
    keys: [
      "folders", "supported", "what can dig find", "types", "kinds of search", "sponsors", "judges", "mentors",
      "speakers", "jobs", "internship", "leads", "competitors", "vendors", "companies", "coming soon",
    ],
    summary:
      "Ask in your own words and Dig picks the right kind of search, then files the results in the matching folder of your event.",
    bullets: [
      "Sponsors: companies that sponsor or partner with events, with their tier and a contact where one is published.",
      "Judges, mentors and speakers: people who have judged, mentored or spoken at events, with their expertise and LinkedIn.",
      "Jobs: open roles and internships at named companies.",
      "Leads: companies you could sell to. Questions about vendors, suppliers or companies in general also run here.",
      "Competitors: alternatives to a product, with pricing where a page states it.",
      "Events, funding and market trends are coming soon.",
    ],
    actionLink: { label: "Open your events", to: "/dashboard" },
  },
  {
    id: "contacts",
    category: "outreach",
    title: "LinkedIn, GitHub and finding another contact",
    keys: ["linkedin", "github", "contact", "another", "reach", "profile", "check", "email", "hunter", "decision maker"],
    summary:
      "After a search, Dig looks for each row's LinkedIn, GitHub and work email, and only keeps one when both the name and the organisation match.",
    bullets: [
      "A faded LinkedIn link marked 'check' matched the name only. Confirm it before writing.",
      "For sponsors and leads, the Another button adds the next person at that company, right under the first one.",
      "If nothing was found, the LinkedIn column offers a one-click LinkedIn search instead.",
    ],
  },
  {
    id: "reruns-and-review",
    category: "veracity",
    title: "Running again, changes and 'Needs review'",
    keys: ["needs review", "conflict", "jev", "diff", "re-run", "rerun", "run again", "refresh", "changes", "dropped", "added", "auto-resolved", "disagree"],
    summary:
      "Running a search again checks the web for what has changed. Dig shows what was added, what changed, and what was not found this time, without duplicating rows.",
    bullets: [
      "When two pages disagree, Dig keeps the clearly better value itself, for example the fuller one, the newer one or the more official one.",
      "Only when it truly can't tell does a row say Needs review. Click Review conflicts to choose.",
      "'Not found this time' does not prove a row is gone; the pages searched were different.",
    ],
  },
  {
    id: "outreach-and-pitch",
    category: "outreach",
    title: "Tracking outreach and writing a pitch",
    keys: ["outreach", "crm", "pitch", "email draft", "interested", "declined", "waiting", "not contacted", "notes", "contacted"],
    summary:
      "Mark where you are with every row and keep short notes for your team. The tabs above the table count each state.",
    bullets: [
      "Four states: Not contacted, Waiting (they'll get back to you), Interested and Declined.",
      "Pitch writes a short first email using only facts Dig found, plus your event's README and your name and role. Edit it, then copy it or open it in your email app.",
      "Dig does not send emails for you.",
    ],
  },
  {
    id: "toolkit",
    category: "workflows",
    title: "Toolkit: Kickoff, Lens, Merger and Flow",
    keys: ["toolkit", "agents", "kickoff", "plan", "planner", "lens", "insight", "merger", "merge", "combine", "flow", "canvas", "workflow", "mission"],
    summary: "Toolkit holds four helpers that work on your events and lists.",
    bullets: [
      "Kickoff: describe your event and deadline; it writes a dated plan and starts the right searches from it.",
      "Lens: a few plain insights for one list, plus a PDF.",
      "Merger: combine several lists into one spreadsheet, with duplicates merged.",
      "Flow: draw an outreach plan step by step, with your approval at the end. It's a prototype and does not send messages yet.",
    ],
    actionLink: { label: "Open Toolkit", to: "/agents" },
  },
  {
    id: "exports",
    category: "exports",
    title: "Downloads and reports",
    keys: ["export", "download", "csv", "excel", "xlsx", "json", "report", "pdf", "spreadsheet", "share"],
    summary: "Every list can be downloaded from the Download button above the table.",
    bullets: [
      "Excel, CSV or JSON for spreadsheets and other tools, including your outreach status and notes.",
      "A black-and-white PDF report with every row and its sources.",
    ],
  },
  {
    id: "plans",
    category: "metering",
    title: "Plans",
    keys: ["pricing", "plan", "price", "cost", "starter", "pro", "scale", "upgrade", "payment", "upi", "utr", "quota", "limits"],
    summary: "The Pricing page lists the plans and what each includes. Opening, filtering and downloading lists you already have never uses up searches.",
    bullets: [
      "A search uses one run each time you start it or run it again.",
      "Pick a plan on the Pricing page.",
    ],
    actionLink: { label: "Open Pricing", to: "/pricing" },
  },
  {
    id: "speed",
    category: "general",
    title: "How long a search takes",
    keys: ["how long", "slow", "speed", "stuck", "progress", "cancel", "waiting for results", "loading"],
    summary: "Most searches take one to two minutes. Dig searches the web, reads the pages, then looks up contact details for every row.",
    bullets: [
      "The progress bar shows each step as it happens.",
      "You can cancel a running search without losing what you already have.",
      "Results vary a little each run, because the web pages found can differ.",
    ],
  },
  {
    id: "events",
    category: "general",
    title: "Events, folders and the README",
    keys: ["event", "readme", "folder", "hide", "archive", "favourite", "rename", "account", "profile", "password", "sign out", "logout"],
    summary: "Each event holds a README and a folder for each kind of search.",
    bullets: [
      "The README is the event's plan of record: dates, targets and deadlines. Pitch drafts use it too.",
      "Hide folders an event doesn't need from the folder's ··· menu; its searches are kept.",
      "Star an event to keep it in Favourites; archive it when you're done.",
    ],
    actionLink: { label: "Open your events", to: "/dashboard" },
  },
];

// ---------------------------------------------------------------------------
// 2. Types & In-Memory RAG Interfaces
// ---------------------------------------------------------------------------
export interface IndexedRecord {
  id: string;
  name: string;
  category: FolderKey;
  eventTitle: string;
  jobName: string;
  fields: Record<string, string | number | boolean>;
  contact?: string | null;
  outreachStatus: "not_contacted" | "waiting" | "interested" | "declined";
  outreachNote?: string;
  sourceUrl?: string;
}

export interface ChatMessage {
  id: string;
  from: "you" | "diglett";
  text: string;
  richCards?: Array<{
    title: string;
    subtitle: string;
    badge?: string;
    badgeColor?: "blue" | "green" | "amber" | "purple";
    details?: string;
    link?: string;
  }>;
  actionLink?: { label: string; to: string };
  fallback?: boolean;
}

const FOLDER_INTENTS: Record<string, FolderKey> = {
  SPONSOR_LOOKUP: "sponsors",
  JUDGE_LOOKUP: "judges",
  JOB_LOOKUP: "jobs",
  LEAD_LOOKUP: "leads",
  COMPETITOR_LOOKUP: "competitors",
  EVENT_LOOKUP: "events",
  PAPER_LOOKUP: "papers",
};

/** Shows **text** as bold instead of printing the asterisks. */
function withBold(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : part,
  );
}

// ---------------------------------------------------------------------------
// 3. Backward-Compatible Keyword Answer Lookup
// ---------------------------------------------------------------------------
export function answerFor(question: string): string | null {
  const q = question.toLowerCase();
  for (const doc of KNOWLEDGE_BASE) {
    if (doc.keys.some((k) => q.includes(k))) {
      return `${doc.summary}\n\nKey Highlights:\n${doc.bullets.map((b) => `• ${b}`).join("\n")}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4. Main AskDiglett Component
// ---------------------------------------------------------------------------
export function AskDiglett() {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "workspace">("chat");
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState<string>("all");
  const [workspaceSearch, setWorkspaceSearch] = useState<string>("");

  const listRef = useRef<HTMLDivElement>(null);
  const { session } = useSession();
  const { events } = useEvents();

  // Query all active jobs in the workspace
  const { data: jobsData, isLoading: jobsLoading } = useQuery({
    queryKey: ["diglett-jobs"],
    queryFn: async () => {
      try {
        return await api<{ jobs: JobSummary[] }>("/api/jobs");
      } catch {
        return { jobs: [] };
      }
    },
    enabled: !!session,
    staleTime: 20_000,
  });

  const jobs = useMemo(() => jobsData?.jobs ?? [], [jobsData]);

  // Index user records from active datasets
  const { data: recordsData, isLoading: recordsLoading } = useQuery({
    queryKey: ["diglett-indexed-records", jobs.map((j) => j.id).join(",")],
    queryFn: async () => {
      const indexed: IndexedRecord[] = [];
      const activeJobs = jobs.slice(0, 8); // index up to 8 recent searches

      await Promise.all(
        activeJobs.map(async (job) => {
          try {
            const [datasetRes, outreachRes] = await Promise.all([
              api<{ records: DatasetRecord[] }>(`/api/jobs/${job.id}/dataset`).catch(() => ({ records: [] })),
              api<{ outreach: Record<string, { status?: string; note?: string }> }>(`/api/jobs/${job.id}/outreach`).catch(() => ({
                outreach: {} as Record<string, { status?: string; note?: string }>,
              })),
            ]);

            const INTENT_TO_CATEGORY: Record<string, FolderKey> = {
              SPONSOR_LOOKUP: "sponsors",
              JUDGE_LOOKUP: "judges",
              JOB_LOOKUP: "jobs",
              LEAD_LOOKUP: "leads",
              COMPETITOR_LOOKUP: "competitors",
              EVENT_LOOKUP: "events",
              PAPER_LOOKUP: "papers",
            };
            const rawIntent = job.intent || job.blueprint?.intent || "";
            const category: FolderKey = INTENT_TO_CATEGORY[rawIntent] ?? "leads";
            const outreachMap: Record<string, { status?: string; note?: string }> = outreachRes.outreach || {};

            for (const rec of datasetRes.records || []) {
              const name =
                (rec.fields.paper_title as string) ||
                (rec.fields.event_name as string) ||
                rec.label ||
                String(rec.fields.company_name || rec.fields.person_name || rec.fields.role_title || "Unnamed Entity");

              const contact =
                typeof rec.fields.email === "string"
                  ? rec.fields.email
                  : typeof rec.fields.contact === "string"
                  ? rec.fields.contact
                  : null;

              const mark = outreachMap[rec.canonicalEntityId];
              const outreachStatus: IndexedRecord["outreachStatus"] =
                mark?.status === "interested" ? "interested" :
                mark?.status === "declined" ? "declined" :
                mark?.status === "waiting" ? "waiting" : "not_contacted";

              indexed.push({
                id: rec.id,
                name,
                category,
                eventTitle: job.name,
                jobName: job.name,
                fields: rec.fields,
                contact,
                outreachStatus,
                outreachNote: mark?.note,
                sourceUrl: rec.evidence?.[0]?.sourceUrl,
              });
            }
          } catch {
            // non-fatal
          }
        })
      );
      return indexed;
    },
    enabled: jobs.length > 0,
    staleTime: 45_000,
  });

  const indexedRecords = useMemo(() => recordsData ?? [], [recordsData]);

  // Aggregate quick statistics
  const stats = useMemo(() => {
    const totalEvents = events.filter((e) => !e.archived).length;
    const totalJobs = jobs.length;
    const totalRecords = indexedRecords.length;
    const interestedCount = indexedRecords.filter((r) => r.outreachStatus === "interested").length;
    const sponsorsCount = indexedRecords.filter((r) => r.category === "sponsors").length;
    const leadsCount = indexedRecords.filter((r) => r.category === "leads").length;
    const judgesCount = indexedRecords.filter((r) => r.category === "judges").length;

    return {
      totalEvents,
      totalJobs,
      totalRecords,
      interestedCount,
      sponsorsCount,
      leadsCount,
      judgesCount,
    };
  }, [events, jobs, indexedRecords]);

  // Dynamic greeting reflecting logged-in user and workspace
  const initialGreeting = useMemo<ChatMessage>(() => {
    if (session?.user) {
      return {
        id: "greet-1",
        from: "diglett",
        text: `Hi ${session.user.name.split(" ")[0]}! I can see **${session.workspace.name}**: ${stats.totalEvents} active events and ${stats.totalRecords} sourced rows. Ask me about your lists, or how anything in Dig works.`,
      };
    }
    return {
      id: "greet-guest",
      from: "diglett",
      text: "Hi! I’m Diglett. Ask me how to find sponsors, judges or leads, or how anything in Dig works.",
    };
  }, [session, stats.totalEvents, stats.totalRecords]);

  const [messages, setMessages] = useState<ChatMessage[]>([initialGreeting]);

  // Update greeting when session loads
  useEffect(() => {
    setMessages([initialGreeting]);
  }, [initialGreeting]);

  // Close on Escape or click outside
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Auto-scroll chat list
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  // -------------------------------------------------------------------------
  // 5. Intelligent Hybrid RAG Query Resolver
  // -------------------------------------------------------------------------
  const resolveQuery = (query: string): ChatMessage => {
    const q = query.toLowerCase().trim();

    // -----------------------------------------------------------------------
    // Stage A: Live Workspace Context Retrieval
    // -----------------------------------------------------------------------

    // A1: Sponsors in user workspace
    if (q.includes("sponsor") || q.includes("who sponsors") || q.includes("my sponsor")) {
      const sponsors = indexedRecords.filter((r) => r.category === "sponsors");
      if (sponsors.length > 0) {
        return {
          id: `rag-${Date.now()}`,
          from: "diglett",
          text: `Found **${sponsors.length} verified sponsor(s)** in your workspace datasets:`,
          richCards: sponsors.slice(0, 5).map((s) => ({
            title: s.name,
            subtitle: `Event / List: ${s.eventTitle}`,
            badge: s.outreachStatus === "interested" ? "Interested" : "Sponsor Record",
            badgeColor: s.outreachStatus === "interested" ? "green" : "blue",
            details: s.contact ? `Contact: ${s.contact}` : "Direct web evidence verified",
            link: s.sourceUrl,
          })),
          actionLink: { label: "Browse Workspace Sponsors", to: "/dashboard" },
        };
      }
    }

    // A1.5: Judges, Mentors & Speakers in user workspace
    if (q.includes("judge") || q.includes("mentor") || q.includes("speaker") || q.includes("keynote") || q.includes("who is speaking")) {
      const people = indexedRecords.filter((r) => r.category === "judges");
      if (people.length > 0) {
        return {
          id: `rag-${Date.now()}`,
          from: "diglett",
          text: `Found **${people.length} verified judge(s), mentor(s) & speaker(s)** in your workspace:`,
          richCards: people.slice(0, 5).map((p) => ({
            title: p.name,
            subtitle: `Affiliation / Event: ${p.fields.affiliation || p.eventTitle}`,
            badge: p.outreachStatus === "interested" ? "Interested" : "Expert / Speaker",
            badgeColor: p.outreachStatus === "interested" ? "green" : "blue",
            details: p.contact ? `Contact: ${p.contact}` : (p.fields.expertise ? `Expertise: ${p.fields.expertise}` : "Profile verified"),
            link: p.sourceUrl,
          })),
          actionLink: { label: "Browse Judges & Speakers", to: "/dashboard" },
        };
      }
    }

    // A2: Leads in user workspace
    if (q.includes("lead") || q.includes("prospect") || q.includes("who to pitch")) {
      const leads = indexedRecords.filter((r) => r.category === "leads");
      if (leads.length > 0) {
        return {
          id: `rag-${Date.now()}`,
          from: "diglett",
          text: `Retrieved **${leads.length} high-intent lead(s)** from your active pipeline:`,
          richCards: leads.slice(0, 5).map((l) => ({
            title: l.name,
            subtitle: `List: ${l.jobName}`,
            badge: l.outreachStatus === "interested" ? "Interested" : "Verified Lead",
            badgeColor: l.outreachStatus === "interested" ? "green" : "purple",
            details: l.contact ? `Verified Channel: ${l.contact}` : "Company evidence verified",
            link: l.sourceUrl,
          })),
          actionLink: { label: "View Leads", to: "/dashboard" },
        };
      }
    }

    // A2.5: Jobs & Roles in user workspace
    if (q.includes("job") || q.includes("role") || q.includes("internship") || q.includes("hiring")) {
      const jobsList = indexedRecords.filter((r) => r.category === "jobs");
      if (jobsList.length > 0) {
        return {
          id: `rag-${Date.now()}`,
          from: "diglett",
          text: `Found **${jobsList.length} verified role(s) & opening(s)** in your workspace:`,
          richCards: jobsList.slice(0, 5).map((j) => ({
            title: j.name,
            subtitle: `Company: ${j.fields.company_name || j.jobName}`,
            badge: "Open Role",
            badgeColor: "blue",
            details: j.fields.location ? `Location: ${j.fields.location}` : "Listing verified",
            link: j.sourceUrl,
          })),
          actionLink: { label: "View Jobs", to: "/dashboard" },
        };
      }
    }

    // A2.6: Competitors in user workspace
    if (q.includes("competitor") || q.includes("alternative")) {
      const compList = indexedRecords.filter((r) => r.category === "competitors");
      if (compList.length > 0) {
        return {
          id: `rag-${Date.now()}`,
          from: "diglett",
          text: `Found **${compList.length} competitor(s) & alternative(s)** in your workspace:`,
          richCards: compList.slice(0, 5).map((c) => ({
            title: c.name,
            subtitle: `Category: ${c.fields.category || "Alternative"}`,
            badge: "Competitor",
            badgeColor: "purple",
            details: c.fields.pricing_signal ? `Pricing: ${c.fields.pricing_signal}` : "Verified",
            link: c.sourceUrl,
          })),
          actionLink: { label: "View Competitors", to: "/dashboard" },
        };
      }
    }

    // A3: Interested outreach status
    if (q.includes("interested") || q.includes("who called") || q.includes("marked") || q.includes("pipeline")) {
      const interested = indexedRecords.filter((r) => r.outreachStatus === "interested");
      if (interested.length > 0) {
        return {
          id: `rag-${Date.now()}`,
          from: "diglett",
          text: `You have **${interested.length} record(s)** marked as **Interested** in your CRM outreach:`,
          richCards: interested.slice(0, 5).map((item) => ({
            title: item.name,
            subtitle: `${item.category.toUpperCase()} · List: ${item.jobName}`,
            badge: "Interested",
            badgeColor: "green",
            details: item.outreachNote ? `Note: "${item.outreachNote}"` : (item.contact ?? "Ready for outreach"),
            link: item.sourceUrl,
          })),
        };
      }
    }

    // A4: Workspace summary / overview
    if (
      q.includes("summary") ||
      q.includes("overview") ||
      q.includes("my workspace") ||
      q.includes("how many") ||
      q.includes("stats") ||
      q.includes("data do i have")
    ) {
      if (session) {
        return {
          id: `rag-${Date.now()}`,
          from: "diglett",
          text: `Here is the live intelligence brief for **${session.workspace.name}**:\n\n` +
            `• **Active Events:** ${stats.totalEvents} hackathon / research briefs\n` +
            `• **Curated Datasets:** ${stats.totalJobs} collection jobs\n` +
            `• **Total Verified Records:** ${stats.totalRecords} indexed entities\n` +
            `• **Breakdown:** ${stats.sponsorsCount} Sponsors · ${stats.leadsCount} Leads · ${stats.judgesCount} Judges & Mentors\n` +
            `• **CRM Status:** ${stats.interestedCount} marked as Interested\n\n` +
            `You can browse all these records directly using the **Workspace Index** tab above!`,
          actionLink: { label: "Go to Dashboard", to: "/dashboard" },
        };
      }
    }

    // A5: Specific entity match across workspace records
    const matchedEntity = indexedRecords.find((r) => q.includes(r.name.toLowerCase()));
    if (matchedEntity) {
      return {
        id: `rag-${Date.now()}`,
        from: "diglett",
        text: `Found verified record for **${matchedEntity.name}** in folder **${matchedEntity.category}**:`,
        richCards: [
          {
            title: matchedEntity.name,
            subtitle: `Dataset: ${matchedEntity.jobName}`,
            badge: matchedEntity.outreachStatus.toUpperCase(),
            badgeColor: matchedEntity.outreachStatus === "interested" ? "green" : "blue",
            details: matchedEntity.contact ? `Contact: ${matchedEntity.contact}` : "Evidence cited on live web",
            link: matchedEntity.sourceUrl,
          },
        ],
      };
    }

    // -----------------------------------------------------------------------
    // Stage B: Platform Knowledge Retrieval
    // -----------------------------------------------------------------------
    let bestDoc: KnowledgeDoc | null = null;
    let highestScore = 0;

    for (const doc of KNOWLEDGE_BASE) {
      let score = 0;
      for (const key of doc.keys) {
        if (key.length <= 3) {
          if (` ${q} `.includes(` ${key} `)) score += 4;
        } else if (q.includes(key)) {
          score += key.split(" ").length * 3 + 2;
        }
      }
      if (score > highestScore) {
        highestScore = score;
        bestDoc = doc;
      }
    }

    if (bestDoc && highestScore >= 3) {
      return {
        id: `rag-${Date.now()}`,
        from: "diglett",
        text: `### ${bestDoc.title}\n\n${bestDoc.summary}\n\n**Key Takeaways:**\n${bestDoc.bullets.map((b) => `• ${b}`).join("\n")}`,
        actionLink: bestDoc.actionLink,
      };
    }

    // -----------------------------------------------------------------------
    // Stage C: Intelligent Fallback with Workspace Awareness
    // -----------------------------------------------------------------------
    return {
      id: `rag-${Date.now()}`,
      from: "diglett",
      text: `I couldn’t find that in your lists or in Dig’s help. Try asking:

• "What can Dig find?"
• "Why do some rows have no email?"
• "What is Toolkit?"
• "Who is interested?"`,
      fallback: true,
      actionLink: { label: "Open Dig Architecture Guide", to: GUIDE_URL },
    };
  };

  const handleAsk = (questionText: string) => {
    const text = questionText.trim();
    if (!text) return;

    const userMsg: ChatMessage = { id: `user-${Date.now()}`, from: "you", text };
    const botResponse = resolveQuery(text);

    setMessages((curr) => [...curr, userMsg, botResponse]);
    setDraft("");
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    handleAsk(draft);
  };

  // Filtered records for the Workspace Explorer tab
  const filteredWorkspaceRecords = useMemo(() => {
    return indexedRecords.filter((rec) => {
      if (workspaceFilter !== "all" && rec.category !== workspaceFilter) return false;
      if (workspaceSearch.trim()) {
        const query = workspaceSearch.toLowerCase();
        return (
          rec.name.toLowerCase().includes(query) ||
          rec.eventTitle.toLowerCase().includes(query) ||
          (rec.contact && rec.contact.toLowerCase().includes(query))
        );
      }
      return true;
    });
  }, [indexedRecords, workspaceFilter, workspaceSearch]);

  const SUGGESTED_PROMPTS = useMemo(() => {
    if (stats.sponsorsCount > 0) {
      return ["Show my sponsors", "Who is interested?", "Why do some rows have no email?", "What is Toolkit?"];
    }
    return ["What can Dig find?", "Why do some rows have no email?", "What is Toolkit?", "How long does a search take?"];
  }, [stats.sponsorsCount]);

  return (
    <>
      {open && (
        <div
          className={`diglett-panel chat ${expanded ? "expanded" : ""}`}
          role="dialog"
          aria-label="Ask Diglett Intelligence Assistant"
          onClick={(e) => e.stopPropagation()}
        >
          {/* macOS Styled Window Titlebar */}
          <div className="diglett-macos-titlebar">
            <div className="diglett-traffic-lights" aria-label="Window controls">
              <Tip text="Close Diglett (Esc)">
                <button type="button" className="diglett-dot red" onClick={() => setOpen(false)} aria-label="Close" />
              </Tip>
              <Tip text={expanded ? "Compact view" : "Minimize"}>
                <button type="button" className="diglett-dot yellow" onClick={() => setExpanded(false)} aria-label="Minimize" />
              </Tip>
              <Tip text={expanded ? "Compact view" : "Expand view"}>
                <button type="button" className="diglett-dot green" onClick={() => setExpanded((v) => !v)} aria-label="Expand view" />
              </Tip>
            </div>
            <div className="diglett-title-center">
              <img src="/art/mole-avatar.png" alt="Diglett" className="diglett-header-avatar" />
              <span className="diglett-title-text">Diglett</span>
            </div>

            <div className="diglett-header-right">
              <Tip text={session ? `Diglett can see the lists in ${session.workspace.name}.` : "Log in so Diglett can see your lists."}>
                <span className={`diglett-sync-pill ${session ? "online" : "offline"}`} tabIndex={0}>
                  <span className="sync-pulse" />
                  <span className="sync-text">{session ? "Synced" : "Guest"}</span>
                </span>
              </Tip>
              <Tip text={expanded ? "Make this panel narrower." : "Make this panel wider."}>
                <button
                  type="button"
                  className="diglett-size-btn"
                  onClick={() => setExpanded((v) => !v)}
                  aria-label={expanded ? "Compact view" : "Expand view"}
                >
                  {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                </button>
              </Tip>
              <Tip text="Close Diglett. Press Esc to close too.">
                <button type="button" className="diglett-size-btn" onClick={() => setOpen(false)} aria-label="Close">
                  <X size={13} />
                </button>
              </Tip>
            </div>
          </div>

          {/* Mode Switcher Tabs */}
          <div className="diglett-mode-tabs">
            <button
              type="button"
              className={`diglett-mode-tab ${activeTab === "chat" ? "active" : ""}`}
              onClick={() => setActiveTab("chat")}
            >
              <Bot size={13} />
              <span>Assistant</span>
            </button>
            <button
              type="button"
              className={`diglett-mode-tab ${activeTab === "workspace" ? "active" : ""}`}
              onClick={() => setActiveTab("workspace")}
            >
              <Database size={13} />
              <span>Workspace</span>
            </button>
          </div>

          {/* Tab 1: Conversational RAG Chat */}
          {activeTab === "chat" && (
            <>
              <div className="chat-list" ref={listRef} aria-live="polite">
                {messages.map((message) => (
                  <div key={message.id} className={`bubble ${message.from === "you" ? "you" : "bot"}`}>
                    <div className="bubble-markdown-content">
                      {message.text.split("\n\n").map((para, idx) => (
                        <p key={idx} style={{ margin: "4px 0" }}>
                          {withBold(para)}
                        </p>
                      ))}
                    </div>

                    {/* Rich Entity / Provenance Cards */}
                    {message.richCards && message.richCards.length > 0 && (
                      <div className="diglett-rich-cards-container">
                        {message.richCards.map((card, cIdx) => (
                          <div key={cIdx} className="diglett-rich-card">
                            <div className="rich-card-top">
                              <span className="rich-card-title">{card.title}</span>
                              {card.badge && (
                                <span className={`rich-card-badge ${card.badgeColor ?? "blue"}`}>
                                  {card.badge}
                                </span>
                              )}
                            </div>
                            <span className="rich-card-sub">{card.subtitle}</span>
                            {card.details && <span className="rich-card-detail">{card.details}</span>}
                            {card.link && (
                              <a
                                href={card.link}
                                target="_blank"
                                rel="noreferrer"
                                className="rich-card-link"
                              >
                                <span>Verified Source URL</span>
                                <ExternalLink size={10} />
                              </a>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Action Links */}
                    {message.actionLink && (
                      <div className="diglett-action-link-row">
                        <Link to={message.actionLink.to} className="diglett-action-pill">
                          <span>{message.actionLink.label}</span>
                          <ChevronRight size={12} />
                        </Link>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Contextual Suggested Questions */}
              <div className="chat-suggest">
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button key={prompt} type="button" onClick={() => handleAsk(prompt)}>
                    <Sparkles size={10} className="sparkle-icon" />
                    <span>{prompt}</span>
                  </button>
                ))}
              </div>

              {/* Input Bar */}
              <form className="chat-input" onSubmit={handleSubmit}>
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={
                    session
                      ? `Ask about ${session.workspace.name} or Dig features…`
                      : "Ask about your lists or how Dig works…"
                  }
                  autoFocus
                  maxLength={300}
                />
                <button type="submit" disabled={!draft.trim()} aria-label="Send query">
                  <Send size={14} />
                </button>
              </form>
            </>
          )}

          {/* Tab 2: Live Workspace Explorer */}
          {activeTab === "workspace" && (
            <div className="diglett-workspace-explorer">
              {/* Stat Counters Banner */}
              <div className="explorer-stats-grid">
                <div className="explorer-stat-box">
                  <Layers size={13} color="#4c6fff" />
                  <span className="stat-val">{stats.totalEvents}</span>
                  <span className="stat-lbl">Events</span>
                </div>
                <div className="explorer-stat-box">
                  <Folder size={13} color="#10b981" />
                  <span className="stat-val">{stats.totalJobs}</span>
                  <span className="stat-lbl">Datasets</span>
                </div>
                <div className="explorer-stat-box">
                  <ShieldCheck size={13} color="#00baf2" />
                  <span className="stat-val">{stats.totalRecords}</span>
                  <span className="stat-lbl">Records</span>
                </div>
                <div className="explorer-stat-box">
                  <Target size={13} color="#f59e0b" />
                  <span className="stat-val">{stats.interestedCount}</span>
                  <span className="stat-lbl">Interested</span>
                </div>
              </div>

              {/* Live Record Search & Filter Bar */}
              <div className="explorer-controls">
                <div className="explorer-search-wrap">
                  <Search size={12} className="search-icon" />
                  <input
                    type="text"
                    value={workspaceSearch}
                    onChange={(e) => setWorkspaceSearch(e.target.value)}
                    placeholder="Search records in workspace…"
                    className="explorer-search-input"
                  />
                  {workspaceSearch && (
                    <button type="button" onClick={() => setWorkspaceSearch("")} className="clear-btn">
                      <X size={11} />
                    </button>
                  )}
                </div>

                <div className="explorer-filter-pills">
                  {["all", "sponsors", "leads", "judges", "jobs", "competitors"].map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      className={`filter-pill ${workspaceFilter === cat ? "active" : ""}`}
                      onClick={() => setWorkspaceFilter(cat)}
                    >
                      {cat.charAt(0).toUpperCase() + cat.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Records List */}
              <div className="explorer-records-list">
                {recordsLoading ? (
                  <div className="explorer-loading-view">
                    <RefreshCw size={18} className="spin" color="#4c6fff" />
                    <span>Indexing workspace datasets…</span>
                  </div>
                ) : filteredWorkspaceRecords.length === 0 ? (
                  <div className="explorer-empty-view">
                    <Folder size={24} color="var(--text-3)" />
                    <p>No records match your filter.</p>
                    {indexedRecords.length === 0 && (
                      <span className="empty-sub">Run a search in an event to populate your workspace.</span>
                    )}
                  </div>
                ) : (
                  filteredWorkspaceRecords.map((rec) => (
                    <div key={rec.id} className="explorer-record-row">
                      <div className="record-main-col">
                        <div className="record-row-head">
                          <span className="record-entity-name">{rec.name}</span>
                          <span className={`record-outreach-pill ${rec.outreachStatus}`}>
                            {rec.outreachStatus.replace("_", " ")}
                          </span>
                        </div>
                        <div className="record-meta-line">
                          <span className="record-cat-tag">{rec.category}</span>
                          <span className="record-event-title">· {rec.eventTitle}</span>
                        </div>
                        {rec.contact && <div className="record-contact-line">📧 {rec.contact}</div>}
                        {rec.outreachNote && (
                          <div className="record-note-line">💬 Note: {rec.outreachNote}</div>
                        )}
                      </div>

                      <button
                        type="button"
                        className="record-inquire-btn"
                        onClick={() => {
                          setActiveTab("chat");
                          handleAsk(`Tell me about ${rec.name} from my ${rec.category} list`);
                        }}
                        title="Ask Diglett about this entity"
                      >
                        Ask Diglett ↗
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Floating Diglett Launcher Button */}
      <button
        className="diglett"
        aria-label="Open Diglett Intelligence Assistant"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <img src="/art/mole-avatar.png" alt="Diglett Avatar" />
        <span className="dot" />
        {!open && <span className="diglett-tip">Ask Diglett</span>}
      </button>
    </>
  );
}
