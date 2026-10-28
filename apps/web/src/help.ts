/**
 * Every hover-help sentence in one place, so the same idea is always worded the same way.
 * Plain words for someone who has never used Dig; no internal names.
 */

/** Words that appear on screen and need a plain explanation. */
export const GLOSSARY = {
  confidence:
    "How strongly a row is backed up: more pages, more official pages and newer pages score higher. 100% means very well backed up.",
  verified: "Every value in this row was copied from a real web page. Open the row to see the pages.",
  sourced: "Copied word for word from a web page, so you can check it yourself.",
  conflict: "A new search found a different value than last time, for example a new email. Dig keeps the more trustworthy one or asks you.",
  needsReview: "Dig found two different values for something and could not tell which is right. You decide.",
  autoResolved: "Dig settled these changes on its own, because one value was clearly newer, fuller or more official.",
  run: "One search of the web. Running again checks for what has changed since last time.",
  version: "Each run saves a new version of the list, so you can see what changed.",
  qualityScore: "Out of 100: how complete, fresh and well backed up this list is overall.",
  jev: "Jev is the AI that helps decide which value to trust when two pages disagree.",
  sources: "The web pages Dig read to build this list.",
} as const;

/** Sidebar, window and page-level controls. */
export const NAV_HELP = {
  favourites: "Events you've starred show up here.",
  recent: "All your events, most recently opened first.",
  archived: "Events you've put away. Nothing is deleted; you can bring them back.",
  toolkit: "Helpers that work on your lists: plan an event, see insights, combine lists, set up outreach.",
  profile: "Your name, email and account details.",
  pricing: "Plans and what each one includes.",
  logOut: "Sign out of Dig on this device.",
  back: "Go back to the previous page.",
  forward: "Go forward again.",
  light: "Switch to the light look.",
  dark: "Switch to the dark look.",
  avatar: "Open your profile.",
  close: "Close and return to your dashboard.",
  minimize: "Minimize window.",
  zoom: "Toggle full screen.",
} as const;

/** The tools, worded the same in the sidebar, the Toolkit page and the intro pop-up. */
export const TOOL_HELP = {
  kickoff: "Plan an event. Tell it your deadline and it writes a dated to-do list, with links to start the right searches.",
  lens: "See what a list is telling you: a few plain insights for that kind of list, plus a PDF.",
  merger: "Combine several lists into one spreadsheet, with duplicates merged.",
  flow: "Draw an outreach plan step by step, with your approval before anything goes out. A prototype: it does not send messages yet.",
  gauntlet: "Zero missed deadlines: track hackathons, countdown chips, deliverable lockboxes, and live team feeds in one cockpit.",
} as const;

/** The search results page. */
export const LIST_HELP = {
  download: "Save this list as Excel, CSV, JSON or a PDF report.",
  runAgain: "Search the web again for this list. You'll see what was added, changed or is no longer found.",
  running: "Dig is searching the web. This usually takes one to two minutes.",
  reviewConflicts: "Open the changes Dig could not settle on its own, so you can pick the right value.",
  noConflicts: "Nothing needs your decision right now.",
  records: "Rows in this list, and how many web pages they came from.",
  added: "New rows found in this run that weren't there last time.",
  changed: "Rows where a detail changed since last time, like a new email.",
  dropped: "Rows the last search found but this one didn't. That doesn't prove they're gone; the pages searched were different.",
  firstVersion: "This is the first run of this list, so there's nothing to compare with yet.",
  fullDiff: "See every row that was added, changed or not found again.",
  evidence: "Open the side panel: where each value came from, contact details and history.",
  closeEvidence: "Close the side panel.",
  search: "Search the rows shown below.",
  tabAll: "Every row in this list.",
  tabContacted: "Rows you've reached out to (Waiting, Interested or Declined).",
  tabInterested: "They said yes or want to talk.",
  tabWaiting: "They'll get back to you.",
  tabDeclined: "They said no.",
  tabNotContacted: "Rows nobody has reached out to yet.",
  tabNeedsReview: GLOSSARY.needsReview,
  pitch: "Write a short first email to this contact, using only facts Dig found and your event details.",
  another: "Find another person at this company, for when your first contact doesn't reply.",
  outreach: "Where you are with this row: Not contacted, Waiting, Interested or Declined. Click to change.",
  note: "A short note for your team, like 'call back Monday'. Click to edit.",
  selectAll: "Select every row shown, to mark or export them together.",
  rank: "Rank: rows with the most details come first.",
  verifiedBadge: `${GLOSSARY.verified} The % is the confidence: ${GLOSSARY.confidence.charAt(0).toLowerCase()}${GLOSSARY.confidence.slice(1)}`,
  resize: "Drag to make this column wider or narrower. Double-click to reset.",
} as const;

/** The event page. */
export const EVENT_HELP = {
  gotSomethingElse: "Ask Dig to find anything in your own words. It files the results in the right folder of this event.",
  editReadme: "Edit this event's name, dates, description and targets.",
  folder: "Open this folder's list. Use ··· to rename, hide, or remove its search.",
  showHidden: "Show the folders you hid for this event.",
} as const;

const CONTACT_EMAIL = "An email address found on a public page (a listing, their own site, or an email directory). Never guessed.";
const COMPANY_LINKEDIN = "The company's LinkedIn page, shown only when found and matched to this company. Otherwise, a button to search LinkedIn yourself.";

/** What each result column actually contains, per kind of search. Taken from what Dig is told to extract. */
export const COLUMN_HELP: Record<string, Record<string, string>> = {
  SPONSOR_LOOKUP: {
    company_name: "A company named as a sponsor or partner on an event page.",
    event_name: "The event this company sponsored, as named on that page.",
    sponsorship_type: "Their sponsor tier or role exactly as the event page wrote it, like 'Gold Sponsor' or 'Cloud Partner'.",
    contact: "A person from this sponsor, only if the same page names them.",
    email: CONTACT_EMAIL,
    linkedin: COMPANY_LINKEDIN,
  },
  JUDGE_LOOKUP: {
    person_name: "The person's full name as written on the page.",
    affiliation: "The company, university or job title they're linked to, as the page wrote it.",
    expertise: "Their field or topic, copied from a page about them. Empty if no page said it.",
    event_name: "The event they judged, mentored or spoke at, if the page named one.",
    email: "An email address seen on a public page. Never guessed.",
    linkedin: "Their LinkedIn profile, shown when both the name and the organisation match. A faded link marked 'check' matched the name only.",
    github: "Their GitHub profile, when found and matched to them.",
  },
  JOB_LOOKUP: {
    role_title: "The job title exactly as the listing wrote it.",
    company_name: "The company that's hiring, not the job website.",
    location: "City or country as the listing wrote it.",
    workplace: "Remote, Hybrid or On-site, only when the listing says so.",
    email: "A contact email for the hiring company, found on a public page. Never guessed.",
    linkedin: "The hiring company's LinkedIn page, when found and matched.",
  },
  LEAD_LOOKUP: {
    company_name: "A company that fits who you're looking for and could become a customer.",
    category: "What the company does, in words copied from a page about it.",
    contact: "A named person at the company, only if the page names them.",
    email: CONTACT_EMAIL,
    phone: "A phone number written on a public page next to this company.",
    linkedin: COMPANY_LINKEDIN,
  },
  COMPETITOR_LOOKUP: {
    company_name: "A product or company that a page presents as an alternative to yours.",
    category: "What the product is, in words from the page, like 'note-taking app'.",
    pricing_signal: "A price exactly as a page wrote it, like 'Free plan' or '$10 per user/month'.",
    website: "The competitor's website, if its address was on the page.",
    email: CONTACT_EMAIL,
    linkedin: COMPANY_LINKEDIN,
  },
  EVENT_LOOKUP: {
    event_name: "The name of the hackathon or event as published on its official page or platform.",
    prize_pool: "The total cash prize pool, bounties, or perks listed for winners and participants.",
    location: "City, venue, or online mode (e.g. In-person, Virtual, Hybrid) as stated.",
    dates: "Event dates, timeline, registration deadline, and duration.",
    organizer: "The organizing institution, company, community, or university host.",
    website: "The official registration or submission page for this event.",
  },
  PAPER_LOOKUP: {
    paper_title: "The published title of the scientific research paper or preprint.",
    authors: "Key authors, researchers, and principal investigators listed on the paper.",
    topic: "The research domain, core methodology, or key breakthrough findings.",
    venue: "The conference, journal, or preprint archive (e.g. arXiv, NeurIPS, ICML, CVPR).",
    year: "The publication or preprint release year.",
    pdf_url: "Direct downloadable link to the open-access PDF document.",
  },
};

export function columnHelp(intent: string, field: string): string | undefined {
  return COLUMN_HELP[intent]?.[field];
}
