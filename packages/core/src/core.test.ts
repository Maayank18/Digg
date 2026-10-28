import { describe, expect, it } from "vitest";
import { buildBlueprint } from "./blueprint.js";
import { dedupeRecords } from "./dedupe.js";
import { collectDemo, DEMO_NOW, SPONSOR_DIFF } from "./demo-data.js";
import { diffDatasets } from "./diff.js";
import { matchIntent } from "./intents.js";
import { applyThreshold, mockJevProvider, type JevDecision } from "./jev.js";
import { canonicalCompanyName, comparisonKey, normalizeEmail, normalizeUrl, similarity } from "./normalize.js";
import { runPipeline } from "./pipeline.js";
import { backoffMs, withRetry } from "./util.js";
import { validateFields } from "./validate.js";

describe("intent matching", () => {
  it("classifies the demo requests without an LLM", () => {
    expect(matchIntent("Find active technology event sponsors in Delhi NCR").intent).toBe("SPONSOR_LOOKUP");
    expect(matchIntent("Find sponsors").intent).toBe("SPONSOR_LOOKUP");
    expect(matchIntent("Find AI and ML job openings in India").intent).toBe("JOB_LOOKUP");
    expect(matchIntent("Map the SaaS competitor landscape for project management tools").intent).toBe("COMPETITOR_LOOKUP");
    expect(matchIntent("Find startup funding opportunities in India").intent).toBe("FUNDING_LOOKUP");
    expect(matchIntent("Find enterprise AI vendors for analytics and machine learning").intent).toBe("VENDOR_LOOKUP");
    expect(matchIntent("Find keynote speakers for AI conference in Delhi").intent).toBe("JUDGE_LOOKUP");
    expect(matchIntent("speaker search").intent).toBe("JUDGE_LOOKUP");
    expect(matchIntent("sponsor search").intent).toBe("SPONSOR_LOOKUP");
    expect(matchIntent("AI hackathon mentors and judges in Bangalore").intent).toBe("JUDGE_LOOKUP");
    expect(matchIntent("find hackathons in delhi").intent).toBe("EVENT_LOOKUP");
    expect(matchIntent("Upcoming AI hackathons in India with cash prizes").intent).toBe("EVENT_LOOKUP");
    expect(matchIntent("find research papers on diffusion models").intent).toBe("PAPER_LOOKUP");
    expect(matchIntent("arxiv preprints on generative video architectures").intent).toBe("PAPER_LOOKUP");
    expect(matchIntent("AI researchers and keynote speakers for our hackathon").intent).toBe("JUDGE_LOOKUP");
  });

  it("builds a sponsor blueprint with Delhi NCR and nine fields", () => {
    const { blueprint, match } = buildBlueprint("Find active technology event sponsors in Delhi NCR");
    expect(blueprint.intent).toBe("SPONSOR_LOOKUP");
    expect(blueprint.entities.location).toBe("Delhi NCR");
    expect(blueprint.entities.category).toBe("technology");
    expect(blueprint.fields).toHaveLength(9);
    expect(blueprint.freshness.required).toBe(true);
    expect(blueprint.freshness.maxAgeDays).toBe(90);
    expect(match.method).toBe("keyword");
    expect(match.confidence).toBeGreaterThan(0.7);
  });
});

describe("normalization", () => {
  it("collapses company legal suffixes", () => {
    expect(canonicalCompanyName("Microsoft Corporation")).toBe("Microsoft");
    expect(canonicalCompanyName("Microsoft Corp.")).toBe("Microsoft");
    expect(canonicalCompanyName("Microsoft")).toBe("Microsoft");
    expect(canonicalCompanyName("Microsoft India Pvt Ltd")).toBe("Microsoft India");
    expect(canonicalCompanyName("Microsoft India Private Limited")).toBe("Microsoft India");
  });

  it("normalizes urls and emails", () => {
    expect(normalizeUrl("HTTP://WWW.Microsoft.com/events/")).toBe("http://microsoft.com/events");
    expect(normalizeEmail("  Sarah.Sharma@Microsoft.com ")).toBe("sarah.sharma@microsoft.com");
  });

  it("scores near-duplicate names above the merge line after suffix stripping", () => {
    const left = canonicalCompanyName("Microsoft India Pvt Ltd").toLowerCase();
    const right = canonicalCompanyName("Microsoft India Private Limited").toLowerCase();
    expect(similarity(left, right)).toBe(1);
  });
});

describe("comparison keys", () => {
  it("treats case, plural and event-kind wording as the same value", () => {
    const same = (a: string, b: string) => expect(comparisonKey("sponsorship_type", a)).toBe(comparisonKey("sponsorship_type", b));
    same("Co-Sponsor", "Co-Sponsors");
    same("Supporting partner", "supporting partner");
    same("Legend Sponsor", "legend sponsor");
    same("Sponsors", "Sponsor");
    same("Sponsor", "Hackathon Sponsor");
    same("sponsor", "sponsored by");
    expect(comparisonKey("phone", "+1 888 672 1076")).toBe(comparisonKey("phone", "+1-888-672-1076"));
  });

  it("still separates genuinely different values", () => {
    const differ = (a: string, b: string) => expect(comparisonKey("sponsorship_type", a)).not.toBe(comparisonKey("sponsorship_type", b));
    differ("Gold Sponsor", "Silver Sponsor");
    differ("Legend Sponsor", "Sponsor");
    differ("Education partner", "Sponsor");
    expect(comparisonKey("email", "priya.nair@infosys.com")).not.toBe(comparisonKey("email", "campus@infosys.com"));
  });
});

describe("validation and dedupe", () => {
  it("rejects an invalid email and a missing company", () => {
    const result = validateFields(
      { company_name: "", event_name: "Summit", source_url: "https://example.com", email: "not-an-email" },
      "SPONSOR_LOOKUP",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.map((issue) => issue.field)).toEqual(expect.arrayContaining(["company_name", "email"]));
  });

  it("merges exact identity and flags uncertain matches", () => {
    const base = {
      sources: [],
      fields: { company_name: "Microsoft India", event_name: "Summit" },
    };
    const merged = dedupeRecords(
      [
        { ...base, canonicalEntityId: "a" },
        { ...base, canonicalEntityId: "b", fields: { ...base.fields, website: "https://microsoft.com" } },
      ],
      ["company_name", "event_name"],
    );
    expect(merged.merged).toBe(1);
    expect(merged.records).toHaveLength(1);
    expect(merged.records[0]?.fields.website).toBe("https://microsoft.com");

    const possible = dedupeRecords(
      [
        { canonicalEntityId: "a", sources: [], fields: { company_name: "Northwind Systems", event_name: "Summit" } },
        { canonicalEntityId: "b", sources: [], fields: { company_name: "Northwind System", event_name: "Summit" } },
      ],
      ["company_name", "event_name"],
    );
    expect(possible.merged).toBe(0);
    expect(possible.possible).toBeGreaterThan(0);
    expect(possible.records.some((record) => record.flags.includes("POSSIBLE_DUPLICATE"))).toBe(true);
  });
});

describe("diff and conflicts", () => {
  it("classifies added, removed, changed, and unchanged identities", () => {
    const diff = diffDatasets({
      previous: [
        { canonicalEntityId: "a", fields: { company_name: "A", contact: "Ann" } },
        { canonicalEntityId: "b", fields: { company_name: "B", contact: "Bo" } },
      ],
      current: [
        { canonicalEntityId: "b", fields: { company_name: "B", contact: "Bea" } },
        { canonicalEntityId: "c", fields: { company_name: "C", contact: "Cy" } },
      ],
      compareFields: ["company_name", "contact"],
    });
    expect(diff.added.map((item) => item.canonicalEntityId)).toEqual(["c"]);
    expect(diff.removed.map((item) => item.canonicalEntityId)).toEqual(["a"]);
    expect(diff.changed.map((item) => item.canonicalEntityId)).toEqual(["b"]);
    expect(diff.unchanged).toHaveLength(0);
    expect(diff.changed[0]?.fields).toEqual([{ field: "contact", from: "Bo", to: "Bea" }]);
  });

  it("keeps low-confidence Jev decisions in human review", () => {
    const low = applyThreshold(
      { decision: "NEW", confidence: 0.62, reason: "unclear", provider: "mock" },
      0.85,
    );
    const high = applyThreshold(mockJevProvider.decide({
      field: "contact",
      oldValue: "John Sharma",
      newValue: "Sarah Sharma",
      ambiguous: false,
      question: "Which contact is current?",
      oldEvidence: {
        id: "1",
        fieldName: "contact",
        value: "John Sharma",
        sourceUrl: "https://events.example/sponsors",
        sourceTitle: "Event page",
        excerpt: "John Sharma",
        collectedAt: DEMO_NOW.toISOString(),
        publishedAt: "2026-09-10",
        authority: "secondary",
        confidence: 0.7,
      },
      newEvidence: {
        id: "2",
        fieldName: "contact",
        value: "Sarah Sharma",
        sourceUrl: "https://microsoft.com/events/india-mobile-congress",
        sourceTitle: "Microsoft official event page",
        excerpt: "Sarah Sharma",
        collectedAt: DEMO_NOW.toISOString(),
        publishedAt: "2026-09-26",
        authority: "official",
        confidence: 0.94,
      },
    }) as JevDecision, 0.85);
    expect(low.status).toBe("PENDING");
    expect(high.status).toBe("AUTO_RESOLVED");
    expect(high.decision.decision).toBe("NEW");
    expect(high.decision.confidence).toBeGreaterThanOrEqual(0.85);
  });
});

describe("sponsor demo pipeline", () => {
  it("turns a rerun into a deterministic diff with four conflicts", async () => {
    const { blueprint } = buildBlueprint("Find active technology event sponsors in Delhi NCR");
    const first = await runPipeline({
      blueprint,
      collected: collectDemo(blueprint, 1),
      now: DEMO_NOW,
      demo: true,
    });
    const second = await runPipeline({
      blueprint,
      collected: collectDemo(blueprint, 2),
      previous: first.records,
      now: DEMO_NOW,
      demo: true,
    });

    expect(first.diff.firstVersion).toBe(true);
    expect(first.records.length).toBeGreaterThan(30);
    expect(first.records.every((record) => record.evidence.length > 0)).toBe(true);
    expect(second.diff.added).toHaveLength(SPONSOR_DIFF.added);
    expect(second.diff.removed).toHaveLength(SPONSOR_DIFF.removed);
    expect(second.diff.changed).toHaveLength(SPONSOR_DIFF.changed);
    expect(second.conflicts).toHaveLength(SPONSOR_DIFF.conflicts);
    expect(second.conflicts.filter((conflict) => conflict.status === "AUTO_RESOLVED")).toHaveLength(2);
    expect(second.conflicts.filter((conflict) => conflict.status === "PENDING")).toHaveLength(2);

    const microsoft = second.records.find((record) => record.canonicalEntityId === "microsoft");
    const adobe = second.records.find((record) => record.canonicalEntityId === "adobe");
    expect(microsoft?.fields.contact).toBe("Sarah Sharma");
    expect(adobe?.fields.contact).toBe("A. Mehta");
    expect(adobe?.status).toBe("needs_review");
    expect(second.records[0]?.activityComponents.recency).toBeGreaterThan(0);
    expect(second.stats.llmCalls).toBe(0);
  });
});

describe("retry", () => {
  it("backs off exponentially and retries retryable failures", async () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    const sleeps: number[] = [];
    let tries = 0;
    const value = await withRetry(
      async () => {
        tries += 1;
        if (tries < 3) {
          const error = new Error("down");
          (error as Error & { retryable?: boolean }).retryable = true;
          throw error;
        }
        return "ok";
      },
      {
        attempts: 3,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        delay: backoffMs,
        jitter: 0,
        isRetryable: (error) => Boolean((error as { retryable?: boolean }).retryable),
      },
    );
    expect(value).toBe("ok");
    expect(tries).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });
});
