import { Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AuthButton, DEMO_URL, MarketingFooter, MarketingNav, TypedLines } from "../components/Marketing";

/*
  Offsets are in source-art pixels (the 4320×3000 illustration), snapped to the
  art's pixel grid so the pupils move like pixel art rather than sliding.
*/
const LOOK_RANGE = { x: 60, up: 18, down: 12 };
const IDLE_GLANCES: Array<[number, number]> = [
  [-LOOK_RANGE.x, 0],
  [LOOK_RANGE.x, 0],
  [0, -LOOK_RANGE.up],
  [0, LOOK_RANGE.down],
  [0, 0],
];

function snap(value: number, step: number) {
  return Math.round(value / step) * step;
}

function MoleEyes() {
  const [look, setLook] = useState<[number, number]>([0, 0]);
  const [blinking, setBlinking] = useState(false);
  const lensRef = useRef<HTMLDivElement>(null);

  // Follow the cursor anywhere on the page; after ~3s of stillness, glance around on its own.
  useEffect(() => {
    let idleTimer = 0;
    let glanceTimer = 0;
    const glance = (step: number) => {
      setLook(IDLE_GLANCES[step % IDLE_GLANCES.length] as [number, number]);
      const pause = step % IDLE_GLANCES.length === IDLE_GLANCES.length - 1 ? 2600 : 750;
      glanceTimer = window.setTimeout(() => glance(step + 1), pause);
    };
    const armIdle = () => {
      window.clearTimeout(idleTimer);
      window.clearTimeout(glanceTimer);
      idleTimer = window.setTimeout(() => glance(0), 3000);
    };
    const onMove = (event: MouseEvent) => {
      const lens = lensRef.current?.getBoundingClientRect();
      if (lens) {
        const nx = Math.max(-1, Math.min(1, (event.clientX - (lens.left + lens.width / 2)) / (window.innerWidth * 0.4)));
        const ny = Math.max(-1, Math.min(1, (event.clientY - (lens.top + lens.height / 2)) / (window.innerHeight * 0.4)));
        setLook([snap(nx * LOOK_RANGE.x, 20), snap(ny < 0 ? ny * LOOK_RANGE.up : ny * LOOK_RANGE.down, 6)]);
      }
      armIdle();
    };
    window.addEventListener("mousemove", onMove);
    armIdle();
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.clearTimeout(idleTimer);
      window.clearTimeout(glanceTimer);
    };
  }, []);

  // Blink roughly every 4 seconds.
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setBlinking(true);
        timer = window.setTimeout(() => {
          setBlinking(false);
          schedule();
        }, 140);
      }, 3500 + Math.random() * 1000);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);

  const [dx, dy] = look;
  // The far (right) lens is foreshortened in the 3/4 view, so that pupil travels less.
  const rdx = Math.max(-24, Math.min(4, snap(dx * 0.4, 4)));
  return (
    <div className={blinking ? "blinking" : undefined}>
      <div className="lens left" ref={lensRef}>
        <div className="pupil" style={{ transform: `translate(${(dx / 72) * 100}%, ${(dy / 87) * 100}%)` }}>
          <i />
        </div>
      </div>
      <div className="lens right">
        <div className="pupil" style={{ transform: `translate(${(rdx / 42) * 100}%, ${(dy / 65) * 100}%)` }}>
          <i />
        </div>
      </div>
    </div>
  );
}

const FEATURES: Array<{ icon: string; title: string; body: string }> = [
  { icon: "icon-folder", title: "Every event, organized.", body: "Sponsors, judges, speakers in one dashboard per event." },
  { icon: "icon-lens", title: "Sourced, not guessed.", body: "Every contact traced back to where it came from." },
  { icon: "icon-refresh", title: "Never stale.", body: "Re-run a job anytime and see exactly what changed." },
  {
    icon: "icon-folders",
    title: "One folder per event.",
    body: "Sponsors, judges, and speakers, organized under the event they belong to — not scattered across sheets and tabs.",
  },
  {
    icon: "icon-shield",
    title: "Conflicts, resolved for you.",
    body: "When data changes, Dig decides what to trust automatically. It only asks you when it’s genuinely unsure.",
  },
  { icon: "icon-export", title: "Export and go.", body: "CSV, Excel, or JSON — ready to hand to your team or plug into your own tools." },
];

export function Landing() {
  return (
    <div className="landing">
      <MarketingNav />

      <section className="hero">
        <div className="hero-copy">
          <TypedLines
            className="hero-title"
            label="We dig the internet for you, so you don’t have to."
            lines={[
              [["We "], ["dig the internet", true], [" for"]],
              [["you, so you don’t have to."]],
            ]}
          />
          <p className="hero-sub">
            Sponsors, judges, speakers — found, sourced, and organized into one space, so your whole team can focus on
            running the event instead of manually hunting for contacts.
          </p>
        </div>
        <div className="hero-art">
          <div className="lantern-glow" />
          <MoleEyes />
        </div>
        <div className="hero-ctas">
          <Link className="px-btn lg" to="/dashboard" style={{ textDecoration: "none" }}>
            Open Workspace &rarr;
          </Link>
          <a className="px-btn lg" href={DEMO_URL} target="_blank" rel="noreferrer">
            <Play size={12} fill="currentColor" style={{ display: "inline" }} /> Watch the demo
          </a>
        </div>
      </section>

      <section className="section" id="features" style={{ paddingTop: 40 }}>
        <h2>What you get, every time you DIG</h2>
        <p className="lede">
          From having fifteen search tabs open to one sourced sheet — Dig does the digging and keeps it all in order.
        </p>
        <div className="features">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="feature">
              <img src={`/art/${feature.icon}.png`} alt="" />
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
