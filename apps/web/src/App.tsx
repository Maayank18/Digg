import type { ReactNode } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { ROOT_CRUMB } from "./events";
import { Auth } from "./pages/Auth";
import { Dashboard } from "./pages/Dashboard";
import { DevLog } from "./pages/DevLog";
import { EventFolder } from "./pages/EventFolder";
import { FolderBoard } from "./pages/FolderBoard";
import { JobBoard } from "./pages/JobBoard";
import { Landing } from "./pages/Landing";
import { AgentsHome } from "./pages/Agents";
import { Flow } from "./pages/Flow";
import { Lens } from "./pages/Lens";
import { Merger } from "./pages/Merger";
import { Kickoff } from "./pages/Kickoff";
import { Gauntlet } from "./pages/Gauntlet";
import { Pricing } from "./pages/Pricing";
import { Profile } from "./pages/Profile";
import { Stack } from "./pages/Stack";
import { WhyDig } from "./pages/WhyDig";
import { RequireAuth } from "./session";
import { EscapeCloses } from "./components/EscapeCloses";

function StandaloneJobBoard() {
  const { jobId = "" } = useParams();
  return <JobBoard jobId={jobId} crumbs={[{ label: ROOT_CRUMB, to: "/dashboard" }, { label: "Job Board" }]} />;
}

const app = (screen: ReactNode) => <RequireAuth>{screen}</RequireAuth>;

export function App() {
  return (
    <>
    <EscapeCloses />
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/why" element={<WhyDig />} />
      <Route path="/dev-log" element={<DevLog />} />
      <Route path="/stack" element={<Stack />} />
      <Route path="/login" element={<Navigate to="/dashboard" replace />} />
      <Route path="/signup" element={<Navigate to="/dashboard" replace />} />
      <Route path="/dashboard" element={app(<Dashboard />)} />
      <Route path="/profile" element={app(<Profile />)} />
      <Route path="/pricing" element={app(<Pricing />)} />
      <Route path="/agents" element={app(<AgentsHome />)} />
      <Route path="/agents/flow" element={app(<Flow />)} />
      <Route path="/agents/lens" element={app(<Lens />)} />
      <Route path="/agents/kickoff" element={app(<Kickoff />)} />
      <Route path="/agents/mission" element={<Navigate to="/agents/kickoff" replace />} />
      <Route path="/agents/merger" element={app(<Merger />)} />
      <Route path="/agents/gauntlet" element={app(<Gauntlet />)} />
      <Route path="/events/:eventId" element={app(<EventFolder />)} />
      <Route path="/events/:eventId/:folder" element={app(<FolderBoard />)} />
      <Route path="/jobs/:jobId" element={app(<StandaloneJobBoard />)} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}
