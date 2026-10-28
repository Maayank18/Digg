import { HelpCircle } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { AppWindow, FolderIcon, markToolkitVisited } from "../components/Shell";
import { Tip } from "../components/Tip";
import { ToolkitIntro, toolkitIntroSeen } from "../components/ToolkitIntro";
import { ROOT_CRUMB } from "../events";
import { TOOL_HELP } from "../help";

const FOLDERS = [
  { to: "/agents/kickoff", name: "Kickoff", help: TOOL_HELP.kickoff },
  { to: "/agents/lens", name: "Lens", help: TOOL_HELP.lens },
  { to: "/agents/merger", name: "Merger", help: TOOL_HELP.merger },
  { to: "/agents/flow", name: "Flow", help: TOOL_HELP.flow },
  { to: "/agents/gauntlet", name: "Gauntlet", help: TOOL_HELP.gauntlet },
];

export function AgentsHome() {
  // Opening Toolkit clears the sidebar's "New" dot; the intro opens by itself only the first time.
  markToolkitVisited();
  const [introOpen, setIntroOpen] = useState(() => !toolkitIntroSeen());
  return (
    <AppWindow
      crumbs={[{ label: ROOT_CRUMB, to: "/dashboard" }, { label: "Toolkit" }]}
      sidebar="agents"
      status="5 folders"
      actions={
        <button className="btn" onClick={() => setIntroOpen(true)}>
          <HelpCircle size={14} /> What is Toolkit?
        </button>
      }
    >
      <div className="content">
        <div className="label-muted">Toolkit</div>
        <div className="folders">
          {FOLDERS.map((folder) => (
            <Tip key={folder.to} text={folder.help}>
              <Link to={folder.to} className="folder">
                <FolderIcon />
                <span className="name">{folder.name}</span>
              </Link>
            </Tip>
          ))}
        </div>
      </div>
      {introOpen && <ToolkitIntro onClose={() => setIntroOpen(false)} />}
    </AppWindow>
  );
}
