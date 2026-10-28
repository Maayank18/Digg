import { CalendarCheck, Layers, ScanSearch, Trophy, Workflow, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

/** Remembers that the intro was seen, so it only opens on its own the first time. */
export const TOOLKIT_INTRO_KEY = "dig-toolkit-intro-seen";

export function toolkitIntroSeen(): boolean {
  try {
    return localStorage.getItem(TOOLKIT_INTRO_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    localStorage.setItem(TOOLKIT_INTRO_KEY, "1");
  } catch {
    // Storage can be blocked; the intro may then show again next time.
  }
}

const TOOLS: Array<{ icon: ReactNode; name: string; line: string }> = [
  { icon: <CalendarCheck size={16} />, name: "Kickoff", line: "Plan an event against its deadline." },
  { icon: <ScanSearch size={16} />, name: "Lens", line: "See what a list is telling you." },
  { icon: <Layers size={16} />, name: "Merger", line: "Combine lists into one spreadsheet." },
  { icon: <Workflow size={16} />, name: "Flow", line: "Sketch an outreach plan. A prototype for now." },
  { icon: <Trophy size={16} />, name: "Gauntlet", line: "Zero missed deadlines: track hackathons & submissions." },
];

/** Short intro to Toolkit: picture on the left, four one-liners on the right, two buttons. */
export function ToolkitIntro({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const dialog = useRef<HTMLDivElement>(null);
  const [imageFailed, setImageFailed] = useState(false);

  const close = () => {
    markSeen();
    onClose();
  };

  // Focus moves in on open, stays inside while open, and returns to where it was on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // preventScroll: focusing the button must never scroll the pop-up and hide its title.
    dialog.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog.current) return;
      const items = [...dialog.current.querySelectorAll<HTMLElement>("button, [href], [tabindex]:not([tabindex='-1'])")];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      previous?.focus({ preventScroll: true });
    };
  }, []);

  // Sits over the workspace (right of the sidebar) and is centred there.
  return (
    <div className="toolkit-intro-backdrop" onClick={close}>
      <div ref={dialog} className="toolkit-intro" role="dialog" aria-modal="true" aria-labelledby="toolkit-intro-title" onClick={(click) => click.stopPropagation()}>
        <div className="toolkit-intro-text">
          <button type="button" className="modal-x toolkit-intro-x" onClick={close} aria-label="Close">
            <X size={15} />
          </button>
          <div className="toolkit-intro-kicker">New</div>
          <h2 id="toolkit-intro-title">Introducing Toolkit</h2>
          <p className="toolkit-intro-lead">Four helpers that turn your lists into next steps.</p>
          <ul>
            {TOOLS.map((tool) => (
              <li key={tool.name}>
                <span className="toolkit-intro-icon">{tool.icon}</span>
                <span>
                  <b>{tool.name}</b>
                  <span>{tool.line}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="toolkit-intro-actions">
            <button
              type="button"
              className="btn blue"
              data-autofocus
              onClick={() => {
                markSeen();
                navigate("/agents/kickoff");
              }}
            >
              Try Kickoff
            </button>
            <button type="button" className="btn" onClick={close}>
              Maybe later
            </button>
          </div>
        </div>
        <div className="toolkit-intro-art" aria-hidden>
          {!imageFailed && <img src="/toolkit-intro.png" alt="" onError={() => setImageFailed(true)} />}
        </div>
      </div>
    </div>
  );
}
