import { Heart } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";

export const GITHUB_URL = "https://github.com/ashima19arora/Dig";
export const GUIDE_URL = "https://github.com/ashima19arora/Dig#readme";
export const DEMO_URL = "https://youtu.be/wxyIEdSFLwU";
const TEAM = [
  { name: "Mayank", url: "https://www.linkedin.com/in/mayankgarg18/" },
  { name: "Ashima", url: "https://www.linkedin.com/in/ashima-arora-0396ab336/" },
];

function GithubMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function LinkedInMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
      <rect width="16" height="16" rx="2.5" fill="currentColor" />
      <path d="M3.6 6.3h1.9V12H3.6zM4.55 3.4a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2zM6.7 6.3h1.8v.8c.3-.5.9-.95 1.9-.95 2 0 2.3 1.3 2.3 3V12h-1.9V9.5c0-.7 0-1.6-1-1.6s-1.15.75-1.15 1.55V12H6.7z" fill="#17110d" />
    </svg>
  );
}

const AUTH_PATHS = { login: "/dashboard", signup: "/dashboard" } as const;

export function AuthButton({ mode, className, children }: { mode: keyof typeof AUTH_PATHS; className: string; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <button className={className} onClick={() => navigate(AUTH_PATHS[mode])}>
      {children}
    </button>
  );
}

const TABS: Array<[string, string]> = [
  ["/", "Home"],
  ["/why", "Why Dig"],
  ["/dev-log", "Dev Log"],
  ["/stack", "The Stack"],
];

export function MarketingNav() {
  const tab = ({ isActive }: { isActive: boolean }) => `mk-link pixel${isActive ? " active" : ""}`;
  return (
    <header className="landing-nav">
      <Link to="/" className="mk-logo">
        <img src="/art/logo.png" alt="Dig" />
      </Link>
      <nav className="mk-nav">
        {TABS.map(([to, label]) => (
          <NavLink key={to} to={to} end className={tab}>
            {label}
          </NavLink>
        ))}
        <a href={GUIDE_URL} target="_blank" rel="noreferrer" className="mk-link pixel">
          Guide
        </a>
        <Link to="/dashboard" className="px-btn mk-signup">
          Open Dashboard
        </Link>
        <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="mk-github pixel">
          <GithubMark /> GitHub
        </a>
      </nav>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="landing-foot">
      made with <Heart size={12} fill="currentColor" style={{ display: "inline", verticalAlign: -1, margin: "0 4px" }} /> during Code
      Cubicle 6.0 by{" "}
      {TEAM.map((person, index) => (
        <span key={person.name}>
          {index > 0 && " & "}
          <a className="mk-person" href={person.url} target="_blank" rel="noreferrer">
            <LinkedInMark />
            <b>{person.name}</b>
          </a>
        </span>
      ))}
    </footer>
  );
}

/**
 * Types `lines` out character by character. The amber cursor stays solid while typing and blinks once done.
 * Each line is an array of [text, highlighted?] runs.
 */
export function TypedLines({ lines, className, label }: { lines: Array<Array<[string, boolean?]>>; className?: string; label: string }) {
  const total = lines.flat().reduce((sum, [text]) => sum + text.length, 0);
  const [typed, setTyped] = useState(0);
  useEffect(() => {
    let count = 0;
    let timer = window.setTimeout(function tick() {
      count += 1;
      setTyped(count);
      if (count < total) timer = window.setTimeout(tick, 42 + Math.random() * 50);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [total]);

  const done = typed >= total;
  // The cursor sits on the line currently being typed, or the last line once done.
  let cursorLine = lines.length - 1;
  for (let i = 0, acc = 0; i < lines.length; i += 1) {
    acc += (lines[i] ?? []).reduce((sum, [text]) => sum + text.length, 0);
    if (typed < acc) {
      cursorLine = i;
      break;
    }
  }
  let remaining = typed;
  return (
    <h1 className={className} aria-label={label}>
      {lines.map((runs, lineIndex) => (
        <span key={lineIndex} style={{ display: "block" }}>
          {runs.map(([text, hl], runIndex) => {
            const shown = text.slice(0, Math.max(0, remaining));
            remaining -= text.length;
            return shown ? (
              <span key={runIndex} className={hl ? "hl" : undefined}>
                {shown}
              </span>
            ) : null;
          })}
          {lineIndex === cursorLine && <span className={`caret${done ? " blink" : ""}`} />}
        </span>
      ))}
    </h1>
  );
}

/** Fades in and slides up the first time it scrolls into view. */
export function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!node || shown) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, shown]);
  return (
    <section ref={setNode} className={`reveal${shown ? " in" : ""}${className ? ` ${className}` : ""}`}>
      {children}
    </section>
  );
}

export function PixelHeading(props: { children: string; as?: "h2" | "div"; className?: string; caret?: boolean }) {
  const { children, as: Tag = "h2", className } = props;
  return (
    <Tag className={`px-heading pixel${className ? ` ${className}` : ""}`}>
      <span className="gt">&gt;</span>
      {children}
      {props.caret && <span className="caret blink" />}
    </Tag>
  );
}
