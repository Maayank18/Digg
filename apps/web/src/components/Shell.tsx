import { Archive, ChevronLeft, ChevronRight, Clock, CreditCard, Folder, LogOut, Moon, MoreHorizontal, Search, Star, Sun, User } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useEvents } from "../events";
import { NAV_HELP } from "../help";
import { Tip } from "./Tip";
import { initials, logOut, useSession } from "../session";
import { AskDiglett } from "./Diglett";

export type SideView = "favourites" | "recent" | "archived" | "profile" | "pricing" | "agents" | "flow" | "lens" | "mission" | "merger" | "gauntlet" | null;
export type Appearance = "light" | "dark";

const APPEARANCE_KEY = "dig-appearance";

export function readAppearance(): Appearance {
  const saved = localStorage.getItem(APPEARANCE_KEY);
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyAppearance(theme: Appearance) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(APPEARANCE_KEY, theme);
  window.dispatchEvent(new Event("dig-appearance"));
}

export function useAppearance() {
  const [theme, setTheme] = useState<Appearance>(readAppearance);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const sync = () => setTheme(readAppearance());
    window.addEventListener("dig-appearance", sync);
    return () => window.removeEventListener("dig-appearance", sync);
  }, [theme]);
  return [theme, (next: Appearance) => applyAppearance(next)] as const;
}

export interface Crumb {
  label: string;
  to?: string;
  icon?: ReactNode;
}

export function AppWindow(props: {
  crumbs: Crumb[];
  actions?: ReactNode;
  search?: { value: string; onChange: (value: string) => void; placeholder?: string };
  sidebar?: SideView | false;
  status?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [theme, setTheme] = useAppearance();
  const [minimized, setMinimized] = useState(false);
  const showSidebar = props.sidebar !== false;
  // React Router numbers in-app history entries; at 0 there is nothing in Dig to go back to.
  const historyIndex = (window.history.state as { idx?: number } | null)?.idx ?? 0;

  const handleClose = () => {
    if (location.pathname !== "/dashboard") {
      navigate("/dashboard");
    } else {
      navigate("/");
    }
  };

  const handleMinimize = () => {
    setMinimized((prev) => !prev);
  };

  const handleZoom = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  };

  if (minimized) {
    return (
      <div className="desk desk-minimized">
        <div
          className="minimized-dock-card"
          onClick={() => setMinimized(false)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") setMinimized(false);
          }}
          aria-label="Dig App Window (Minimized) - Click to restore"
        >
          <div className="window-traffic-lights" onClick={(e) => e.stopPropagation()}>
            <Tip text={NAV_HELP.close}>
              <button
                type="button"
                className="window-dot red"
                onClick={() => {
                  setMinimized(false);
                  handleClose();
                }}
                aria-label="Close"
              >
                <svg width="6" height="6" viewBox="0 0 8 8">
                  <path d="M1.5 1.5l5 5m0-5l-5 5" stroke="rgba(0,0,0,0.7)" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </button>
            </Tip>
            <Tip text={NAV_HELP.minimize}>
              <button
                type="button"
                className="window-dot yellow"
                onClick={() => setMinimized(false)}
                aria-label="Restore window"
              >
                <svg width="6" height="6" viewBox="0 0 8 8">
                  <path d="M1.5 4h5" stroke="rgba(0,0,0,0.7)" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </button>
            </Tip>
            <Tip text={NAV_HELP.zoom}>
              <button
                type="button"
                className="window-dot green"
                onClick={handleZoom}
                aria-label="Full screen zoom"
              >
                <svg width="6" height="6" viewBox="0 0 8 8">
                  <path d="M1.5 5.5l5-5m-4 0h4v4m-1 3.5h-4v-4" stroke="rgba(0,0,0,0.7)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </Tip>
          </div>
          <div className="minimized-dock-content">
            <span className="minimized-dock-badge">DIG</span>
            <span className="minimized-dock-title">
              {props.crumbs[props.crumbs.length - 1]?.label ?? "Workspace"}
            </span>
            <span className="minimized-dock-sub">Minimized &bull; Click to restore</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="desk">
      <div className="window">
        <div className="titlebar">
          <div className={`titlebar-leading ${showSidebar ? "with-sidebar" : ""}`}>
            <div className="window-traffic-lights" aria-label="Window controls">
              <Tip text={NAV_HELP.close}>
                <button
                  type="button"
                  className="window-dot red"
                  onClick={handleClose}
                  aria-label="Close window"
                >
                  <svg width="6" height="6" viewBox="0 0 8 8">
                    <path d="M1.5 1.5l5 5m0-5l-5 5" stroke="rgba(0,0,0,0.7)" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                </button>
              </Tip>
              <Tip text={NAV_HELP.minimize}>
                <button
                  type="button"
                  className="window-dot yellow"
                  onClick={handleMinimize}
                  aria-label="Minimize window"
                >
                  <svg width="6" height="6" viewBox="0 0 8 8">
                    <path d="M1.5 4h5" stroke="rgba(0,0,0,0.7)" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                </button>
              </Tip>
              <Tip text={NAV_HELP.zoom}>
                <button
                  type="button"
                  className="window-dot green"
                  onClick={handleZoom}
                  aria-label="Full screen zoom"
                >
                  <svg width="6" height="6" viewBox="0 0 8 8">
                    <path d="M1.5 5.5l5-5m-4 0h4v4m-1 3.5h-4v-4" stroke="rgba(0,0,0,0.7)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </Tip>
            </div>
          </div>
          <div className="nav-arrows">
            <Tip text={NAV_HELP.back}>
              <button onClick={() => navigate(-1)} aria-label="Back" disabled={historyIndex === 0}>
                <ChevronLeft size={18} />
              </button>
            </Tip>
            <Tip text={NAV_HELP.forward}>
              <button onClick={() => navigate(1)} aria-label="Forward">
                <ChevronRight size={18} />
              </button>
            </Tip>
          </div>
          <nav className="crumbs">
            {props.crumbs.map((crumb, index) => {
              const last = index === props.crumbs.length - 1;
              return (
                <span
                  key={`${crumb.label}-${index}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    minWidth: 0,
                    flexShrink: last ? 1 : 0,
                    whiteSpace: "nowrap",
                  }}
                >
                  {index > 0 && <ChevronRight size={14} color="#aeaeb2" style={{ flexShrink: 0 }} />}
                  {crumb.icon}
                  {last || !crumb.to ? (
                    <b style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{crumb.label}</b>
                  ) : (
                    <Link to={crumb.to} style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{crumb.label}</Link>
                  )}
                </span>
              );
            })}
          </nav>
          <div className="spacer" />
          {props.actions}
          {props.search && (
            <label className="search">
              <Search size={14} />
              <input
                value={props.search.value}
                onChange={(event) => props.search?.onChange(event.target.value)}
                placeholder={props.search.placeholder ?? "Search"}
              />
            </label>
          )}
          <div className="titlebar-appearance" role="group" aria-label="Color Theme">
            <Tip text={NAV_HELP.light}>
              <button type="button" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>
                <Sun size={13} />
                <span>Light</span>
              </button>
            </Tip>
            <Tip text={NAV_HELP.dark}>
              <button type="button" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>
                <Moon size={13} />
                <span>Dark</span>
              </button>
            </Tip>
          </div>
          {showSidebar && <Avatar />}
        </div>
        <div className="window-body">
          {props.sidebar !== false && <Sidebar active={props.sidebar ?? null} />}
          <div className="window-main" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", position: "relative" }}>{props.children}</div>
        </div>
        {props.status !== undefined && <div className="statusbar">{props.status}</div>}
        <AskDiglett />
      </div>
    </div>
  );
}

/** Remembers that Toolkit has been opened once. */
export const TOOLKIT_VISITED_KEY = "dig-toolkit-visited";

export function markToolkitVisited() {
  try {
    localStorage.setItem(TOOLKIT_VISITED_KEY, "1");
  } catch {
    // Storage can be blocked; the dot then simply stays.
  }
}

function Sidebar({ active }: { active: SideView }) {
  const navigate = useNavigate();
  const { events } = useEvents();
  const live = events.filter((event) => !event.archived);
  const items: Array<{ key: "favourites" | "recent" | "archived"; label: string; icon: ReactNode; count: number }> = [
    { key: "favourites", label: "Favourites", icon: <Star size={16} />, count: live.filter((event) => event.favourite).length },
    { key: "recent", label: "Recent", icon: <Clock size={16} />, count: live.length },
    { key: "archived", label: "Archived", icon: <Archive size={16} />, count: events.length - live.length },
  ];
  return (
    <aside className="sidebar">
      <h6>Events</h6>
      <div className="side-group">
        {items.map((item) => (
          <Tip key={item.key} text={NAV_HELP[item.key]} block>
            <Link to={`/dashboard?view=${item.key}`} className={`side-item${active === item.key ? " active" : ""}`}>
              {item.icon}
              {item.label}
              <span className="count">{item.count}</span>
            </Link>
          </Tip>
        ))}
      </div>
      <h6>Toolkit</h6>
      <div className="side-group">
        <Tip text={NAV_HELP.toolkit} block>
          <Link to="/agents" className={`side-item${active === "agents" || active === "flow" || active === "lens" || active === "mission" || active === "merger" || active === "gauntlet" ? " active" : ""}`}>
            <Folder size={16} />
            Toolkit
            <span className="count">5</span>
          </Link>
        </Tip>
      </div>
      <h6>Account</h6>
      <div className="side-group">
        <Tip text={NAV_HELP.profile} block>
          <Link to="/profile" className={`side-item${active === "profile" ? " active" : ""}`}>
            <User size={16} />
            Profile
          </Link>
        </Tip>
        <Tip text={NAV_HELP.pricing} block>
          <Link to="/pricing" className={`side-item${active === "pricing" ? " active" : ""}`}>
            <CreditCard size={16} />
            Pricing
          </Link>
        </Tip>
        <Tip text={NAV_HELP.logOut} block>
          <button className="side-item" onClick={() => void logOut().finally(() => navigate("/"))}>
            <LogOut size={16} />
            Log Out
          </button>
        </Tip>
      </div>
    </aside>
  );
}

function Avatar() {
  const { session } = useSession();
  const name = session?.user.name ?? "";
  const badge = initials(name);
  return (
    <Tip text={name ? `${name}: ${NAV_HELP.avatar.toLowerCase()}` : NAV_HELP.avatar}>
      <Link to="/profile" className="avatar" aria-label="Open profile">
        {badge || <User size={15} />}
      </Link>
    </Tip>
  );
}

/**
 * A folder tile that opens `to`, with a "⋯" menu. Choosing "Rename" swaps the name for an inline field:
 * Enter or clicking away saves, Escape cancels.
 */
export function FolderTile(props: {
  to: string;
  name: string;
  starred?: boolean;
  menu: Array<{ label: string; onClick: () => void }>;
  onRename: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  if (renaming) {
    const finish = (value: string | null) => {
      setRenaming(false);
      const name = value?.trim();
      if (name && name !== props.name) props.onRename(name);
    };
    return (
      <div className="folder renaming">
        <FolderIcon starred={props.starred} />
        <input
          className="rename"
          aria-label={`Rename ${props.name}`}
          defaultValue={props.name}
          autoFocus
          onFocus={(focus) => focus.target.select()}
          onBlur={(blur) => finish(blur.target.value)}
          onKeyDown={(key) => {
            if (key.key === "Enter") finish(key.currentTarget.value);
            if (key.key === "Escape") finish(null);
          }}
        />
      </div>
    );
  }

  const items = [{ label: "Rename", onClick: () => setRenaming(true) }, ...props.menu];
  return (
    <Link to={props.to} className="folder">
      <FolderIcon starred={props.starred} />
      <span className="name">{props.name}</span>
      <button
        className={`more${open ? " open" : ""}`}
        aria-label={`More actions for ${props.name}`}
        onClick={(click) => {
          click.preventDefault();
          click.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div className="menu" onClick={(click) => click.preventDefault()}>
          {items.map((item) => (
            <button key={item.label} onClick={item.onClick}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </Link>
  );
}

export function FolderIcon({ starred, size = 94 }: { starred?: boolean; size?: number }) {
  const h = Math.round(size * 0.76);
  return (
    <svg width={size} height={h} viewBox="0 0 94 72" aria-hidden>
      <defs>
        <linearGradient id="fb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7cc4f7" />
          <stop offset="1" stopColor="#5cb0f1" />
        </linearGradient>
      </defs>
      <path d="M4 10a6 6 0 0 1 6-6h22l7 7h45a6 6 0 0 1 6 6v6H4z" fill="#62b5f2" />
      <rect x="2" y="15" width="90" height="55" rx="6" fill="url(#fb)" />
      <rect x="2" y="15" width="90" height="2" rx="1" fill="#9fd4fa" opacity="0.8" />
      {starred && (
        <path
          d="M81 53l2.2 4.5 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.5 5-.7z"
          fill="#fff"
        />
      )}
    </svg>
  );
}

export function NewFolderIcon({ size = 94 }: { size?: number }) {
  const h = Math.round(size * 0.76);
  return (
    <svg width={size} height={h} viewBox="0 0 94 72" aria-hidden>
      <path d="M4 10a6 6 0 0 1 6-6h22l7 7h45a6 6 0 0 1 6 6v53H4z" fill="#f4f8fd" />
      <path
        d="M10 4.5h21.8l7 7h45.2a5.5 5.5 0 0 1 5.5 5.5v47.5a5.5 5.5 0 0 1-5.5 5.5H10a5.5 5.5 0 0 1-5.5-5.5V10A5.5 5.5 0 0 1 10 4.5z"
        fill="none"
        stroke="#a9cdf1"
        strokeWidth="1.3"
        strokeDasharray="4 3"
      />
      <path d="M47 30v20M37 40h20" stroke="#4a90d9" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
