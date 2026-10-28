import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  Code2,
  Copy,
  ExternalLink,
  FileText,
  Flame,
  Globe,
  Layers,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Share2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Trophy,
  User,
  Users,
  Video,
  X,
  Zap,
} from "lucide-react";
import { useState, useMemo, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { AppWindow } from "../components/Shell";
import { Tip } from "../components/Tip";
import { ROOT_CRUMB } from "../events";
import { useSession } from "../session";
import { notify, notifyError } from "../toast";

export type GauntletPhase = "targeting" | "ideation" | "hacking" | "demo" | "won";

export interface GauntletTeammate {
  name: string;
  role: string;
  email?: string;
}

export interface GauntletChecklistItem {
  id: string;
  title: string;
  completed: boolean;
  completedAt?: string | null;
  assignedTo?: string | null;
  mandatory?: boolean;
}

export interface GauntletMember {
  id: string;
  name: string;
  email?: string;
  role: string;
  joinedAt: string;
}

export interface GauntletRoom {
  id: string;
  code: string;
  name: string;
  type: "solo" | "squad";
  description: string | null;
  ownerId: string;
  workspaceId: string | null;
  members: GauntletMember[];
  createdAt: string;
  updatedAt: string;
  hackathonsCount?: number;
}

export interface GauntletUpdate {
  id: string;
  hackathonId: string;
  userId: string;
  authorName: string;
  body: string;
  badge: "update" | "blocker" | "milestone" | "submission";
  createdAt: string;
}

export interface GauntletHackathon {
  id: string;
  userId: string;
  workspaceId: string | null;
  roomId?: string | null;
  name: string;
  phase: GauntletPhase;
  targetDate: string | null;
  submitDeadline: string | null;
  roundDate: string | null;
  prizePool: string | null;
  organizer: string | null;
  registrar: string | null;
  track: string | null;
  link: string | null;
  repoUrl: string | null;
  deckUrl: string | null;
  demoUrl: string | null;
  submissionUrl: string | null;
  registrantsCount: number;
  registrantsAsOf: string | null;
  checklist?: GauntletChecklistItem[];
  teammates: GauntletTeammate[];
  tags: string[];
  notes: string | null;
  results: string | null;
  createdAt: string;
  updatedAt: string;
  updatesCount?: number;
  latestUpdate?: GauntletUpdate | null;
  readinessScore?: number;
}

export interface GauntletStats {
  totalChased: number;
  activeHacking: number;
  trophiesWon: number;
  closestDeadline: { name: string; deadline: string } | null;
}

export interface DiscoveredEvent {
  name: string;
  organizer: string;
  dates: string;
  prizePool: string;
  website: string;
  track: string;
  jobId: string;
  searchName: string;
  mainPanelEvent?: string;
}

const PHASES: Array<{ id: GauntletPhase; title: string; subtitle: string; icon: string }> = [
  { id: "targeting", title: "Targeting", subtitle: "Scouting & Eligibility", icon: "🎯" },
  { id: "ideation", title: "Ideation", subtitle: "Pitch Deck & Thesis", icon: "💡" },
  { id: "hacking", title: "Hacking", subtitle: "MVP & Active Sprint", icon: "⚡" },
  { id: "demo", title: "Submission", subtitle: "Demo & Final Portal", icon: "🚀" },
  { id: "won", title: "Trophies", subtitle: "Podium & Archive", icon: "🏆" },
];

function formatTimeRemaining(isoDate: string | null): { text: string; status: "urgent" | "soon" | "normal" | "passed" } {
  if (!isoDate) return { text: "No deadline set", status: "normal" };
  const target = new Date(isoDate).getTime();
  if (!Number.isFinite(target)) return { text: isoDate, status: "normal" };
  const ms = target - Date.now();
  if (ms <= 0) return { text: "DEADLINE PASSED", status: "passed" };
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  if (hours < 24) return { text: `${hours}h left!`, status: "urgent" };
  if (days <= 3) return { text: `${days}d left`, status: "soon" };
  return { text: `${days} days left`, status: "normal" };
}

export function Gauntlet() {
  const queryClient = useQueryClient();
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const currentRoomId = params.get("room");

  // Modals & UI state
  const [createRoomOpen, setCreateRoomOpen] = useState(false);
  const [joinRoomOpen, setJoinRoomOpen] = useState(false);
  const [newRoomType, setNewRoomType] = useState<"solo" | "squad">("solo");
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomDesc, setNewRoomDesc] = useState("");
  const [newRoomRole, setNewRoomRole] = useState("Fullstack Hacker");
  const [joinCode, setJoinCode] = useState("");
  const [joinRole, setJoinRole] = useState("Teammate");

  // Editing existing room
  const [editingRoom, setEditingRoom] = useState<GauntletRoom | null>(null);
  const [editRoomName, setEditRoomName] = useState("");
  const [editRoomDesc, setEditRoomDesc] = useState("");
  const [editRoomType, setEditRoomType] = useState<"solo" | "squad">("solo");

  const [activeDrawerHackathon, setActiveDrawerHackathon] = useState<GauntletHackathon | null>(null);
  const [editingCard, setEditingCard] = useState<Partial<GauntletHackathon> | null>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  const [newUpdateBody, setNewUpdateBody] = useState("");
  const [newUpdateBadge, setNewUpdateBadge] = useState<"update" | "blocker" | "milestone" | "submission">("update");
  const [newUpdateAuthor, setNewUpdateAuthor] = useState(() => session?.user?.name || "Me");
  const [isSubmittingUpdate, setIsSubmittingUpdate] = useState(false);

  // Quick inline add task state
  const [quickTaskTexts, setQuickTaskTexts] = useState<Record<string, string>>({});

  // 1. Fetch Rooms List
  const { data: roomsData, isLoading: roomsLoading } = useQuery<{ rooms: GauntletRoom[] }>({
    queryKey: ["gauntlet-rooms"],
    queryFn: () => api<{ rooms: GauntletRoom[] }>("/api/agents/gauntlet/rooms"),
    refetchInterval: 15_000,
  });

  const rooms = useMemo(() => roomsData?.rooms ?? [], [roomsData]);
  const soloRooms = useMemo(() => rooms.filter((r) => r.type === "solo"), [rooms]);
  const squadRooms = useMemo(() => rooms.filter((r) => r.type === "squad"), [rooms]);

  // 2. Fetch Board Hackathons (scoped to currentRoomId if provided)
  const { data: boardData, isLoading: boardLoading } = useQuery<{
    hackathons: GauntletHackathon[];
    activeRoom: GauntletRoom | null;
    stats: GauntletStats;
  }>({
    queryKey: ["gauntlet-board", currentRoomId],
    queryFn: () => {
      const url = currentRoomId ? `/api/agents/gauntlet?room=${encodeURIComponent(currentRoomId)}` : "/api/agents/gauntlet";
      return api<{ hackathons: GauntletHackathon[]; activeRoom: GauntletRoom | null; stats: GauntletStats }>(url);
    },
    enabled: Boolean(currentRoomId),
    refetchInterval: 10_000,
  });

  // Active room metadata
  const activeRoom = useMemo(() => {
    if (!currentRoomId) return null;
    return rooms.find((r) => r.id === currentRoomId) || boardData?.activeRoom || null;
  }, [rooms, currentRoomId, boardData]);

  // Gracefully fallback to lobby if room param is invalid or room was deleted
  useEffect(() => {
    if (!roomsLoading && !boardLoading && currentRoomId && rooms.length > 0 && !activeRoom) {
      setParams({});
    }
  }, [roomsLoading, boardLoading, currentRoomId, rooms.length, activeRoom, setParams]);

  // 3. Fetch Available Events from Dig (strictly main panel EVENT_LOOKUP)
  const { data: availableEventsData } = useQuery<{ events: DiscoveredEvent[] }>({
    queryKey: ["gauntlet-available-events"],
    queryFn: () => api<{ events: DiscoveredEvent[] }>("/api/agents/gauntlet/available-events"),
    enabled: importModalOpen,
  });

  const hackathons = useMemo(() => boardData?.hackathons ?? [], [boardData]);
  const stats = boardData?.stats ?? { totalChased: 0, activeHacking: 0, trophiesWon: 0, closestDeadline: null };

  // Filter hackathons
  const filteredHackathons = useMemo(() => {
    if (!searchFilter.trim()) return hackathons;
    const q = searchFilter.toLowerCase();
    return hackathons.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        (h.track && h.track.toLowerCase().includes(q)) ||
        (h.organizer && h.organizer.toLowerCase().includes(q)) ||
        (h.registrar && h.registrar.toLowerCase().includes(q)),
    );
  }, [hackathons, searchFilter]);

  const hackathonsByPhase = useMemo(() => {
    const map: Record<GauntletPhase, GauntletHackathon[]> = {
      targeting: [],
      ideation: [],
      hacking: [],
      demo: [],
      won: [],
    };
    for (const h of filteredHackathons) {
      if (map[h.phase]) {
        map[h.phase].push(h);
      } else {
        map.targeting.push(h);
      }
    }
    return map;
  }, [filteredHackathons]);

  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const enterRoom = (roomId: string) => {
    setParams({ room: roomId });
  };

  const returnToLobby = () => {
    setParams({});
  };

  const copyRoomCode = (code: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => {
      setCopiedCode((prev) => (prev === code ? null : prev));
    }, 2000);
    notify(`Squad code "${code}" copied to clipboard! Share with your team.`);
  };

  const openCreateModal = (type: "solo" | "squad") => {
    setNewRoomType(type);
    setNewRoomName("");
    setNewRoomDesc("");
    setCreateRoomOpen(true);
  };

  // Create room (Solo or Squad)
  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRoomName.trim()) {
      notifyError("Arena name is required.");
      return;
    }
    try {
      const res = await api<{ room: GauntletRoom }>("/api/agents/gauntlet/rooms", {
        method: "POST",
        body: JSON.stringify({
          name: newRoomName.trim(),
          type: newRoomType,
          description: newRoomDesc.trim() || null,
          ownerRole: newRoomType === "squad" ? newRoomRole.trim() || "Squad Lead" : "Solo Hacker",
        }),
      });
      notify(`${res.room.type === "solo" ? "Solo Cockpit" : "Squad War-Room"} "${res.room.name}" created!`);
      setCreateRoomOpen(false);
      setNewRoomName("");
      setNewRoomDesc("");
      queryClient.invalidateQueries({ queryKey: ["gauntlet-rooms"] });
      enterRoom(res.room.id);
    } catch {
      notifyError("Failed to create room.");
    }
  };

  // Edit existing room
  const openEditRoom = (room: GauntletRoom, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingRoom(room);
    setEditRoomName(room.name);
    setEditRoomDesc(room.description || "");
    setEditRoomType(room.type);
  };

  const handleSaveEditedRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRoom || !editRoomName.trim()) {
      notifyError("Arena name is required.");
      return;
    }
    try {
      const res = await api<{ room: GauntletRoom }>(`/api/agents/gauntlet/rooms/${editingRoom.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editRoomName.trim(),
          description: editRoomDesc.trim() || null,
          type: editRoomType,
        }),
      });
      notify(`Arena "${res.room.name}" updated!`);
      setEditingRoom(null);
      queryClient.invalidateQueries({ queryKey: ["gauntlet-rooms"] });
    } catch {
      notifyError("Failed to update arena.");
    }
  };

  // Join squad room
  const handleJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCode.trim()) {
      notifyError("Room code is required.");
      return;
    }
    try {
      const res = await api<{ room: GauntletRoom }>("/api/agents/gauntlet/rooms/join", {
        method: "POST",
        body: JSON.stringify({
          code: joinCode.trim().toUpperCase(),
          name: session?.user?.name || "Teammate",
          role: joinRole.trim() || "Member",
        }),
      });
      notify(`Joined Squad War-Room "${res.room.name}"!`);
      setJoinRoomOpen(false);
      setJoinCode("");
      queryClient.invalidateQueries({ queryKey: ["gauntlet-rooms"] });
      enterRoom(res.room.id);
    } catch {
      notifyError("Invalid room code or room not found.");
    }
  };

  // Delete room (Solo or Squad)
  const handleDeleteRoom = async (roomId: string, name: string, type: "solo" | "squad", e: React.MouseEvent) => {
    e.stopPropagation();
    const typeLabel = type === "solo" ? "solo cockpit" : "squad war-room";
    if (!window.confirm(`Delete ${typeLabel} "${name}" and all its tracked campaigns?`)) return;
    try {
      await api(`/api/agents/gauntlet/rooms/${roomId}`, { method: "DELETE" });
      notify(`${type === "solo" ? "Solo cockpit" : "Squad war-room"} deleted.`);
      queryClient.invalidateQueries({ queryKey: ["gauntlet-rooms"] });
      if (currentRoomId === roomId) returnToLobby();
    } catch {
      notifyError("Failed to delete arena.");
    }
  };

  // Toggle checklist item
  const toggleChecklistItem = async (hackathon: GauntletHackathon, itemId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const currentList = hackathon.checklist ?? [];
    const updatedList = currentList.map((item) => {
      if (item.id === itemId) {
        const nextState = !item.completed;
        return {
          ...item,
          completed: nextState,
          completedAt: nextState ? new Date().toISOString() : null,
          assignedTo: nextState ? session?.user?.name || "Me" : item.assignedTo,
        };
      }
      return item;
    });

    try {
      const res = await api<{ hackathon: GauntletHackathon }>(`/api/agents/gauntlet/${hackathon.id}/checklist`, {
        method: "PUT",
        body: JSON.stringify({ checklist: updatedList }),
      });
      queryClient.invalidateQueries({ queryKey: ["gauntlet-board", currentRoomId] });
      if (activeDrawerHackathon?.id === hackathon.id) {
        setActiveDrawerHackathon(res.hackathon);
      }
    } catch {
      notifyError("Failed to update checklist.");
    }
  };

  // Add custom checklist item
  const addChecklistItem = async (hackathon: GauntletHackathon, title: string) => {
    if (!title.trim()) return;
    const currentList = hackathon.checklist ?? [];
    const newItem: GauntletChecklistItem = {
      id: "task-" + Math.random().toString(36).slice(2, 8),
      title: title.trim(),
      completed: false,
      mandatory: false,
    };
    const updatedList = [...currentList, newItem];

    try {
      const res = await api<{ hackathon: GauntletHackathon }>(`/api/agents/gauntlet/${hackathon.id}/checklist`, {
        method: "PUT",
        body: JSON.stringify({ checklist: updatedList }),
      });
      queryClient.invalidateQueries({ queryKey: ["gauntlet-board", currentRoomId] });
      setQuickTaskTexts((prev) => ({ ...prev, [hackathon.id]: "" }));
      if (activeDrawerHackathon?.id === hackathon.id) {
        setActiveDrawerHackathon(res.hackathon);
      }
      notify("Follow-up task added.");
    } catch {
      notifyError("Failed to add task.");
    }
  };

  // Quick phase shift
  const movePhase = async (hackathon: GauntletHackathon, direction: "next" | "prev") => {
    const currentIndex = PHASES.findIndex((p) => p.id === hackathon.phase);
    if (currentIndex === -1) return;
    const nextIndex = direction === "next" ? currentIndex + 1 : currentIndex - 1;
    if (nextIndex < 0 || nextIndex >= PHASES.length) return;
    const nextPhase = PHASES[nextIndex]!.id;

    try {
      await api<{ hackathon: GauntletHackathon }>(`/api/agents/gauntlet/${hackathon.id}`, {
        method: "PATCH",
        body: JSON.stringify({ phase: nextPhase }),
      });
      notify(`Moved to ${PHASES[nextIndex]!.title}`);
      queryClient.invalidateQueries({ queryKey: ["gauntlet-board", currentRoomId] });
    } catch {
      notifyError("Failed to shift phase.");
    }
  };

  // Delete card
  const deleteHackathon = async (id: string, name: string) => {
    if (!window.confirm(`Remove "${name}" from this room?`)) return;
    try {
      await api(`/api/agents/gauntlet/${id}`, { method: "DELETE" });
      notify("Hackathon removed.");
      if (activeDrawerHackathon?.id === id) setActiveDrawerHackathon(null);
      if (editingCard?.id === id) setEditingCard(null);
      queryClient.invalidateQueries({ queryKey: ["gauntlet-board", currentRoomId] });
    } catch {
      notifyError("Failed to delete.");
    }
  };

  // Refresh live attendees / registrants
  const refreshRegistrants = async (id: string) => {
    try {
      const res = await api<{ hackathon: GauntletHackathon; syncedAt: string }>(`/api/agents/gauntlet/${id}/refresh`, {
        method: "POST",
      });
      notify(`Synced: ${res.hackathon.registrantsCount.toLocaleString()} registrants`);
      queryClient.invalidateQueries({ queryKey: ["gauntlet-board", currentRoomId] });
    } catch {
      notifyError("Sync failed.");
    }
  };

  // Save Card (Create or Update)
  const saveCard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCard?.name?.trim()) {
      notifyError("Hackathon title is required.");
      return;
    }

    try {
      if (editingCard.id) {
        await api(`/api/agents/gauntlet/${editingCard.id}`, {
          method: "PATCH",
          body: JSON.stringify(editingCard),
        });
        notify("Hackathon updated.");
      } else {
        await api("/api/agents/gauntlet", {
          method: "POST",
          body: JSON.stringify({
            ...editingCard,
            roomId: currentRoomId || null,
          }),
        });
        notify("Hackathon campaign launched in this room!");
      }
      setEditingCard(null);
      queryClient.invalidateQueries({ queryKey: ["gauntlet-board", currentRoomId] });
    } catch {
      notifyError("Failed to save hackathon.");
    }
  };

  // Post update to card
  const postUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeDrawerHackathon || !newUpdateBody.trim()) return;
    setIsSubmittingUpdate(true);
    try {
      await api(`/api/agents/gauntlet/${activeDrawerHackathon.id}/updates`, {
        method: "POST",
        body: JSON.stringify({
          authorName: newUpdateAuthor.trim() || session?.user?.name || "Me",
          body: newUpdateBody.trim(),
          badge: newUpdateBadge,
        }),
      });
      setNewUpdateBody("");
      notify("Progress logged!");
      const updated = await api<{ hackathon: GauntletHackathon }>(`/api/agents/gauntlet/${activeDrawerHackathon.id}`);
      setActiveDrawerHackathon(updated.hackathon);
      queryClient.invalidateQueries({ queryKey: ["gauntlet-board", currentRoomId] });
    } catch {
      notifyError("Failed to post update.");
    } finally {
      setIsSubmittingUpdate(false);
    }
  };

  // Import event from Dig
  const importDiscoveredEvent = async (ev: DiscoveredEvent) => {
    try {
      await api("/api/agents/gauntlet", {
        method: "POST",
        body: JSON.stringify({
          name: ev.name,
          organizer: ev.organizer,
          prizePool: ev.prizePool,
          link: ev.website,
          track: ev.track,
          phase: "targeting",
          roomId: currentRoomId || null,
          notes: `Imported from Dig search: ${ev.searchName}${ev.mainPanelEvent ? ` (Main Panel Event: ${ev.mainPanelEvent})` : ""}. Dates: ${ev.dates}`,
        }),
      });
      notify(`Imported "${ev.name}" into current room!`);
      queryClient.invalidateQueries({ queryKey: ["gauntlet-board", currentRoomId] });
      setImportModalOpen(false);
    } catch {
      notifyError("Could not import event.");
    }
  };

  // Calculate total prize pool estimate
  const totalPrizeText = useMemo(() => {
    let hasDollars = false;
    let sum = 0;
    for (const h of hackathons) {
      if (!h.prizePool) continue;
      const num = parseInt(h.prizePool.replace(/[^0-9]/g, ""), 10);
      if (!Number.isNaN(num)) {
        sum += num;
        if (h.prizePool.includes("$")) hasDollars = true;
      }
    }
    if (sum === 0) return "$0";
    return hasDollars ? `$${sum.toLocaleString()}` : `₹${sum.toLocaleString()}`;
  }, [hackathons]);

  // ---------------------------------------------------------------------------
  // VIEW 1: PRE-FLIGHT ROOM LOBBY / GATEWAY
  // ---------------------------------------------------------------------------
  if (!currentRoomId) {
    return (
      <AppWindow
        crumbs={[{ label: ROOT_CRUMB, to: "/dashboard" }, { label: "Toolkit", to: "/agents" }, { label: "Gauntlet Hangar" }]}
        sidebar="gauntlet"
        status={`${rooms.length} ${rooms.length === 1 ? "active room" : "active rooms"}`}
        actions={
          <div className="lobby-header-actions" style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
            <button className="btn primary" onClick={() => openCreateModal("squad")}>
              <Plus size={13} /> New Arena
            </button>
            <button className="btn" onClick={() => setJoinRoomOpen(true)}>
              <Share2 size={13} /> Join Code
            </button>
          </div>
        }
      >
      <div className="content gauntlet-page-content">
        <div className="gauntlet-lobby">
          {/* LOBBY HERO BANNER */}
          <div className="lobby-hero">
            <div className="lobby-hero-main">
              <div className="lobby-hero-badge">
                <Sparkles size={11} /> HACKATHON COMMAND GATEWAY
              </div>
              <h2 className="lobby-hero-title">Solo Cockpits &amp; Squad War-Rooms</h2>
              <p className="lobby-hero-desc">
                Choose your arena before entering the Gauntlet. Pilot your private campaigns with zero distraction,
                or assemble a squad war-room with shared follow-up checklists, deliverable lockboxes, and live execution feeds.
              </p>
            </div>

            <div className="lobby-hero-feature-grid">
              <div className="hero-feature-box">
                <div className="feature-box-head">
                  <span className="feature-icon solo"><User size={13} /></span>
                  <span className="feature-label">Solo Cockpit</span>
                </div>
                <p className="feature-desc">Private tracking for independent builders without team chatter.</p>
              </div>
              <div className="hero-feature-box">
                <div className="feature-box-head">
                  <span className="feature-icon squad"><Users size={13} /></span>
                  <span className="feature-label">Squad War-Room</span>
                </div>
                <p className="feature-desc">Shared checklists, repo lockboxes, and passkey invites.</p>
              </div>
            </div>
          </div>

          {/* ROOMS LIST SECTION */}
          <div className="lobby-rooms-section">
            <div className="lobby-section-header">
              <div>
                <div className="lobby-section-title">
                  <Layers size={16} /> Your Active War-Rooms &amp; Cockpits
                </div>
                <div className="lobby-section-sub">
                  Select an arena to enter its 5-phase Kanban execution engine and follow-up gates.
                </div>
              </div>
              <div className="lobby-section-actions">
                <button className="btn small" onClick={() => openCreateModal("solo")}>
                  <User size={12} /> + Solo Cockpit
                </button>
                <button className="btn primary small" onClick={() => openCreateModal("squad")}>
                  <Users size={12} /> + Squad Room
                </button>
                <button className="btn small" onClick={() => setJoinRoomOpen(true)}>
                  <Share2 size={12} /> Join with Code
                </button>
              </div>
            </div>

            <div className="lobby-rooms-grid">
              {/* All Solo Cockpits */}
              {soloRooms.map((room) => {
                const isOwner = room.ownerId === session?.user?.id;
                const campaignCount = room.hackathonsCount ?? 0;
                return (
                  <div key={room.id} className="room-card solo-card">
                    <div className="room-card-top">
                      <span className="room-type-tag solo">
                        <span className="status-dot green" /> Solo Cockpit
                      </span>
                      <div className="room-top-actions">
                        <span className="room-role-pill">Private</span>
                        {isOwner && (
                          <>
                            <button
                              className="room-action-btn"
                              title="Edit Cockpit Name / Description"
                              onClick={(e) => openEditRoom(room, e)}
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              className="room-delete-btn"
                              title="Delete Solo Cockpit"
                              onClick={(e) => handleDeleteRoom(room.id, room.name, "solo", e)}
                            >
                              <Trash2 size={12} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="room-card-main">
                      <h3 className="room-card-title">{room.name}</h3>
                      <p className="room-card-desc">
                        {room.description || "Your personal command board. Built for solo hackers tracking individual registrations, deck links, and GitHub repos without team noise."}
                      </p>
                      <div className="room-meta-chips">
                        <span className="room-meta-chip"><User size={11} /> Solo Hacker</span>
                        <span className="room-meta-chip">🔒 Private Dossier</span>
                      </div>
                    </div>
                    <div className="room-card-footer">
                      <span className="room-hackathons-count">
                        ⚡ {campaignCount === 1 ? "1 active campaign" : `${campaignCount} active campaigns`}
                      </span>
                      <button className="btn primary small enter-btn" onClick={() => enterRoom(room.id)}>
                        Enter Cockpit <ArrowRight size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* All Squad War-Rooms */}
              {squadRooms.map((room) => {
                const isOwner = room.ownerId === session?.user?.id;
                const memberCount = room.members.length;
                const campaignCount = room.hackathonsCount ?? 0;
                return (
                  <div key={room.id} className="room-card squad-card">
                    <div className="room-card-top">
                      <span className="room-type-tag squad">
                        <span className="status-dot indigo" /> Squad War-Room
                      </span>
                      <div className="room-top-actions">
                        <span className="room-role-pill">{isOwner ? "Owner" : "Member"}</span>
                        {isOwner && (
                          <>
                            <button
                              className="room-action-btn"
                              title="Edit Squad Room Name / Description"
                              onClick={(e) => openEditRoom(room, e)}
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              className="room-delete-btn"
                              title="Delete Squad Room"
                              onClick={(e) => handleDeleteRoom(room.id, room.name, "squad", e)}
                            >
                              <Trash2 size={12} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="room-card-main">
                      <h3 className="room-card-title">{room.name}</h3>
                      <p className="room-card-desc">
                        {room.description || "Shared squad space for live deliverable lockbox, follow-up checklists, and blockers."}
                      </p>

                      {/* Shareable Invite Code */}
                      <div
                        className={`room-code-badge ${copiedCode === room.code ? "copied" : ""}`}
                        onClick={(e) => copyRoomCode(room.code, e)}
                        title="Click to copy squad invite code"
                      >
                        <span className="code-prefix">INVITE:</span>
                        <span className="code-val">{room.code}</span>
                        {copiedCode === room.code ? (
                          <span className="code-copied-chip">
                            <Check size={11} strokeWidth={3} /> Copied!
                          </span>
                        ) : (
                          <Copy size={11} className="room-code-copy-icon" />
                        )}
                      </div>

                      {/* Teammates */}
                      <div className="room-members-roster">
                        <span className="roster-label">
                          <Users size={12} /> {memberCount === 1 ? "1 Squad Member:" : `${memberCount} Squad Members:`}
                        </span>
                        <div className="roster-chips">
                          {(room.members ?? []).slice(0, 3).map((m, idx) => (
                            <span key={idx} className="room-member-chip" title={`${m.name} (${m.role})`}>
                              {m.name}
                            </span>
                          ))}
                          {memberCount > 3 && (
                            <span className="room-member-chip overflow">+{memberCount - 3} more</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="room-card-footer">
                      <span className="room-hackathons-count">
                        🔥 {campaignCount === 1 ? "1 team campaign" : `${campaignCount} team campaigns`}
                      </span>
                      <button className="btn primary small enter-btn" onClick={() => enterRoom(room.id)}>
                        Enter War-Room <ArrowRight size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Clean Squad Prompt Card (Visible when 0 squads exist, side-by-side with solo card!) */}
              {squadRooms.length === 0 && (
                <div className="room-card create-squad-prompt-card">
                  <div className="room-card-top">
                    <span className="room-type-tag empty-tag">
                      <Users size={11} /> Squad Collaboration
                    </span>
                    <span className="room-role-pill">Ready to assemble</span>
                  </div>
                  <div className="room-card-main">
                    <h3 className="room-card-title">Assemble a Squad War-Room</h3>
                    <p className="room-card-desc">
                      Forming a team for an upcoming hackathon? Create a shared war-room to coordinate GitHub repos, pitch decks,
                      demo videos, and real-time follow-up gates.
                    </p>
                    <div className="room-meta-chips">
                      <span className="room-meta-chip"><Share2 size={11} /> Invite Passkey</span>
                      <span className="room-meta-chip">👥 Shared Lockbox</span>
                    </div>
                  </div>
                  <div className="prompt-actions-row">
                    <button className="btn primary small" onClick={() => openCreateModal("squad")}>
                      <Plus size={12} /> Create Squad Room
                    </button>
                    <button className="btn small" onClick={() => setJoinRoomOpen(true)}>
                      <Share2 size={12} /> Join with Code
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

        {/* MODAL: CREATE ROOM (SOLO OR SQUAD) */}
        {createRoomOpen && (
          <div className="gauntlet-modal-overlay" onClick={() => setCreateRoomOpen(false)}>
            <div className="gauntlet-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <div>
                  <div className="modal-badge">
                    {newRoomType === "solo" ? <User size={13} /> : <Users size={13} />}
                    {newRoomType === "solo" ? "SOLO COMMAND COCKPIT" : "SQUAD COLLABORATION"}
                  </div>
                  <h3>{newRoomType === "solo" ? "Create New Solo Cockpit" : "Create New Squad War-Room"}</h3>
                </div>
                <button className="modal-close-btn" onClick={() => setCreateRoomOpen(false)}>
                  <X size={16} />
                </button>
              </div>

              {/* Segmented Type Toggle */}
              <div className="room-type-toggle">
                <button
                  type="button"
                  className={`type-toggle-btn ${newRoomType === "solo" ? "active" : ""}`}
                  onClick={() => setNewRoomType("solo")}
                >
                  <User size={13} /> Solo Cockpit (Private)
                </button>
                <button
                  type="button"
                  className={`type-toggle-btn ${newRoomType === "squad" ? "active" : ""}`}
                  onClick={() => setNewRoomType("squad")}
                >
                  <Users size={13} /> Squad War-Room (Team)
                </button>
              </div>

              <form onSubmit={handleCreateRoom} className="modal-form">
                <div className="form-row">
                  <label>
                    {newRoomType === "solo" ? "Solo Cockpit Name *" : "Squad / Room Name *"}
                    <input
                      type="text"
                      placeholder={
                        newRoomType === "solo"
                          ? "e.g. AI Solo Sprints 2026, Personal Web3 Chases, Solo Q4"
                          : "e.g. AI Titans 2026, Nexus Web3 Crew, ETHGlobal Squad"
                      }
                      value={newRoomName}
                      onChange={(e) => setNewRoomName(e.target.value)}
                      required
                    />
                  </label>
                </div>

                <div className="form-row">
                  <label>
                    {newRoomType === "solo" ? "Cockpit Focus / Description" : "Squad Goal / Description"}
                    <textarea
                      rows={2}
                      placeholder={
                        newRoomType === "solo"
                          ? "e.g. Focused private sprint board for personal projects, quick prototypes, and solo submissions."
                          : "e.g. Chasing 3 upcoming AI agent hackathons in Nov 2026. Submitting fullstack MVP + Pitch deck."
                      }
                      value={newRoomDesc}
                      onChange={(e) => setNewRoomDesc(e.target.value)}
                    />
                  </label>
                </div>

                {newRoomType === "squad" && (
                  <div className="form-row">
                    <label>
                      Your Role in this Squad
                      <input
                        type="text"
                        placeholder="e.g. Squad Lead / Fullstack, Frontend Engineer, Pitch & AI"
                        value={newRoomRole}
                        onChange={(e) => setNewRoomRole(e.target.value)}
                      />
                    </label>
                  </div>
                )}

                <div className="modal-actions">
                  <button type="button" className="btn" onClick={() => setCreateRoomOpen(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn primary">
                    {newRoomType === "solo" ? "Launch Solo Cockpit ➔" : "Launch Squad Room ➔"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* MODAL: EDIT ARENA (SOLO OR SQUAD) */}
        {editingRoom && (
          <div className="gauntlet-modal-overlay" onClick={() => setEditingRoom(null)}>
            <div className="gauntlet-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <div>
                  <div className="modal-badge">
                    <Pencil size={12} /> ARENA CONFIGURATION
                  </div>
                  <h3>Edit {editingRoom.type === "solo" ? "Solo Cockpit" : "Squad War-Room"}</h3>
                </div>
                <button className="modal-close-btn" onClick={() => setEditingRoom(null)}>
                  <X size={16} />
                </button>
              </div>

              {/* Segmented Type Toggle */}
              <div className="room-type-toggle">
                <button
                  type="button"
                  className={`type-toggle-btn ${editRoomType === "solo" ? "active" : ""}`}
                  onClick={() => setEditRoomType("solo")}
                >
                  <User size={13} /> Solo Cockpit (Private)
                </button>
                <button
                  type="button"
                  className={`type-toggle-btn ${editRoomType === "squad" ? "active" : ""}`}
                  onClick={() => setEditRoomType("squad")}
                >
                  <Users size={13} /> Squad War-Room (Team)
                </button>
              </div>

              <form onSubmit={handleSaveEditedRoom} className="modal-form">
                <div className="form-row">
                  <label>
                    Arena Name *
                    <input
                      type="text"
                      value={editRoomName}
                      onChange={(e) => setEditRoomName(e.target.value)}
                      required
                    />
                  </label>
                </div>

                <div className="form-row">
                  <label>
                    Description
                    <textarea
                      rows={2}
                      value={editRoomDesc}
                      onChange={(e) => setEditRoomDesc(e.target.value)}
                    />
                  </label>
                </div>

                <div className="modal-actions" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <button
                    type="button"
                    className="btn danger"
                    onClick={(e) => {
                      handleDeleteRoom(editingRoom.id, editingRoom.name, editingRoom.type, e);
                      setEditingRoom(null);
                    }}
                  >
                    <Trash2 size={13} /> Delete Arena
                  </button>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button type="button" className="btn" onClick={() => setEditingRoom(null)}>
                      Cancel
                    </button>
                    <button type="submit" className="btn primary">
                      Save Changes
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* MODAL: JOIN SQUAD ROOM WITH CODE */}
        {joinRoomOpen && (
          <div className="gauntlet-modal-overlay" onClick={() => setJoinRoomOpen(false)}>
            <div className="gauntlet-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <div>
                  <div className="modal-badge">
                    <Share2 size={13} /> INSTANT SYNC
                  </div>
                  <h3>Join Squad War-Room with Code</h3>
                </div>
                <button className="modal-close-btn" onClick={() => setJoinRoomOpen(false)}>
                  <X size={16} />
                </button>
              </div>

              <form onSubmit={handleJoinRoom} className="modal-form">
                <div className="form-row">
                  <label>
                    Enter 6-Character Squad Code *
                    <input
                      type="text"
                      placeholder="e.g. SQUAD-9A4X"
                      value={joinCode}
                      onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                      style={{ fontFamily: "monospace", letterSpacing: "2px", fontWeight: "bold" }}
                      required
                    />
                  </label>
                </div>

                <div className="form-row">
                  <label>
                    Your Role in this Squad
                    <input
                      type="text"
                      placeholder="e.g. Frontend Engineer, ML Specialist, Designer"
                      value={joinRole}
                      onChange={(e) => setJoinRole(e.target.value)}
                    />
                  </label>
                </div>

                <div className="modal-actions">
                  <button type="button" className="btn" onClick={() => setJoinRoomOpen(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn primary">
                    Join War-Room ➔
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </AppWindow>
    );
  }

  // ---------------------------------------------------------------------------
  // VIEW 2: INSIDE ROOM (COCKPIT OR SQUAD WAR-ROOM)
  // ---------------------------------------------------------------------------
  const isSolo = activeRoom?.type === "solo";

  return (
    <AppWindow
      crumbs={[
        { label: ROOT_CRUMB, to: "/dashboard" },
        { label: "Toolkit", to: "/agents" },
        { label: "Gauntlet", to: "/agents/gauntlet" },
        { label: activeRoom?.name || "Command Board" },
      ]}
      sidebar="gauntlet"
      status={`${hackathons.length} ${hackathons.length === 1 ? "active campaign" : "active campaigns"}`}
      actions={
        <div className="gauntlet-header-actions" style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
          <button className="btn" onClick={() => setImportModalOpen(true)}>
            <Sparkles size={13} className="accent-sparkle" /> Import from Dig
          </button>
          <button
            className="btn primary"
            onClick={() => setEditingCard({ phase: "targeting", teammates: [], tags: [], roomId: currentRoomId })}
          >
            <Plus size={13} /> New Hackathon
          </button>
        </div>
      }
    >
      <div className="content gauntlet-page-content">
        <div className="gauntlet-container">
        {/* ROOM COMMAND & NAVIGATION STRIP */}
        <div className="gauntlet-room-strip">
          <div className="room-strip-main">
            <button className="room-back-btn" onClick={returnToLobby} title="Return to Arenas Lobby">
              <ArrowLeft size={13} /> All Arenas
            </button>

            <div className={`room-strip-badge ${isSolo ? "solo" : "squad"}`}>
              {isSolo ? <User size={12} /> : <Users size={12} />}
              <span>{isSolo ? "Solo Cockpit" : "Squad War-Room"}</span>
            </div>

            <h2 className="room-strip-title" title={activeRoom?.name}>
              {activeRoom?.name || "Command Board"}
            </h2>

            {!isSolo && activeRoom?.code && (
              <Tip text="Click to copy squad invite passkey">
                <div
                  className={`room-code-badge ${copiedCode === activeRoom.code ? "copied" : ""}`}
                  onClick={(e) => copyRoomCode(activeRoom.code, e)}
                >
                  <span className="code-prefix">INVITE:</span>
                  <span className="code-val">{activeRoom.code}</span>
                  {copiedCode === activeRoom.code ? (
                    <span className="code-copied-chip">
                      <Check size={11} strokeWidth={3} /> Copied!
                    </span>
                  ) : (
                    <Copy size={11} className="room-code-copy-icon" />
                  )}
                </div>
              </Tip>
            )}
          </div>

          <div className="room-strip-controls">
            {!isSolo && (
              <div className="room-strip-roster">
                <span className="roster-count">
                  <Users size={12} /> {activeRoom?.members?.length ?? 1} squad members
                </span>
                <div className="roster-bubbles">
                  {(activeRoom?.members ?? []).slice(0, 4).map((m, idx) => (
                    <span key={idx} className="roster-bubble" title={`${m.name} (${m.role})`}>
                      {(m.name || "Hacker").slice(0, 2).toUpperCase()}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {activeRoom && activeRoom.ownerId === session?.user?.id && (
              <button
                className="btn small"
                onClick={(e) => openEditRoom(activeRoom, e)}
                title="Configure Arena Name & Description"
              >
                <Pencil size={12} /> Edit Arena
              </button>
            )}
          </div>
        </div>
        {/* TOP COMMAND HUD */}
        <div className="gauntlet-hud">
          <div className="hud-card spotlight">
            <div className="hud-label">
              <Flame size={14} className="flame-icon" /> Next Imminent Deadline
            </div>
            <div className="hud-value">
              {stats.closestDeadline ? (
                <>
                  <span className="deadline-name">{stats.closestDeadline.name}</span>
                  <span className="deadline-time-chip urgent">
                    {formatTimeRemaining(stats.closestDeadline.deadline).text}
                  </span>
                </>
              ) : (
                <span className="deadline-empty">All submissions up to date</span>
              )}
            </div>
          </div>

          <div className="hud-card">
            <div className="hud-label">
              <Zap size={14} /> Active Build Sprints
            </div>
            <div className="hud-value-large">
              {stats.activeHacking} <span className="sub-unit">in flight</span>
            </div>
          </div>

          <div className="hud-card">
            <div className="hud-label">
              <Trophy size={14} /> Total Prize Purse Chased
            </div>
            <div className="hud-value-large gold">{totalPrizeText}</div>
          </div>

          <div className="hud-card">
            <div className="hud-label">
              <ShieldCheck size={14} /> Trophy Cabinet
            </div>
            <div className="hud-value-large green">
              {stats.trophiesWon} <span className="sub-unit">victories</span>
            </div>
          </div>
        </div>

        {/* SEARCH AND FILTER BAR */}
        <div className="gauntlet-toolbar">
          <div className="gauntlet-search">
            <input
              type="text"
              placeholder="Search hackathons, tracks, organizers or teammates..."
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              className="gauntlet-search-input"
            />
            {searchFilter && (
              <button className="clear-btn" onClick={() => setSearchFilter("")}>
                <X size={13} />
              </button>
            )}
          </div>
          <div className="gauntlet-helper-tip">
            {isSolo
              ? "🎯 Solo Hacker Cockpit: Keep your countdowns tight, deliverable links locked, and gates cleared."
              : `👥 Squad War-Room (${activeRoom?.members.length ?? 1} hackers): Track who registered us, share PPT & video demo links, and check off follow-up gates.`}
          </div>
        </div>

        {/* 5-PHASE KANBAN BOARD */}
        <div className="gauntlet-kanban">
          {PHASES.map((phase) => {
            const phaseCards = hackathonsByPhase[phase.id] || [];
            return (
              <div key={phase.id} className={`gauntlet-col phase-${phase.id}`}>
                <div className="col-header">
                  <div className="col-header-title">
                    <span className="col-icon">{phase.icon}</span>
                    <span className="col-name">{phase.title}</span>
                    <span className="col-count">{phaseCards.length}</span>
                  </div>
                  <button
                    className="col-add-btn"
                    title={`Add hackathon to ${phase.title}`}
                    onClick={() => setEditingCard({ phase: phase.id, teammates: [], tags: [], roomId: currentRoomId })}
                  >
                    <Plus size={13} />
                  </button>
                </div>
                <div className="col-subtitle">{phase.subtitle}</div>

                <div className="col-cards">
                  {phaseCards.length === 0 ? (
                    <div className="empty-col-dropzone">
                      <span>No hackathons in this gate</span>
                    </div>
                  ) : (
                    phaseCards.map((card) => {
                      const countdown = formatTimeRemaining(card.submitDeadline || card.targetDate);
                      const hasBlocker = card.latestUpdate?.badge === "blocker";

                      // Checklist stats
                      const checklist = card.checklist ?? [];
                      const completedCount = checklist.filter((item) => item.completed).length;
                      const totalCount = checklist.length;
                      const allDone = totalCount > 0 && completedCount === totalCount;
                      const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

                      return (
                        <div key={card.id} className={`gauntlet-card ${hasBlocker ? "has-blocker" : ""}`}>
                          {/* Top Badges */}
                          <div className="card-top-row">
                            {card.organizer && <span className="organizer-badge">{card.organizer}</span>}
                            {card.prizePool && <span className="prize-badge">{card.prizePool}</span>}
                            <span className={`countdown-chip ${countdown.status}`}>{countdown.text}</span>
                          </div>

                          {/* Title & Track */}
                          <h4 className="card-title" onClick={() => setEditingCard(card)} title="Click to edit details">
                            {card.name}
                          </h4>
                          {card.track && <div className="card-track">Track: {card.track}</div>}

                          {/* Pre-Flight Readiness Bar */}
                          <div className="readiness-block">
                            <div className="readiness-meta">
                              <span>Submission Readiness</span>
                              <span className="readiness-pct">{card.readinessScore ?? 0}%</span>
                            </div>
                            <div className="readiness-track">
                              <div
                                className={`readiness-fill ${(card.readinessScore ?? 0) >= 80 ? "ready" : (card.readinessScore ?? 0) >= 40 ? "mid" : "low"}`}
                                style={{ width: `${card.readinessScore ?? 0}%` }}
                              />
                            </div>
                          </div>

                          {/* FOLLOW-UP CHECKLIST MATRIX */}
                          <div className="card-checklist-container">
                            <div
                              className="checklist-summary-row"
                              onClick={() => setActiveDrawerHackathon(card)}
                              title="Click to view full checklist and timeline"
                            >
                              <div className="checklist-title-label">
                                <CheckCircle2 size={12} /> Follow-Up Gates
                              </div>
                              <span className={`checklist-progress-chip ${allDone ? "complete" : ""}`}>
                                {completedCount}/{totalCount} done
                              </span>
                            </div>

                            <div className="checklist-progress-bar">
                              <div className="checklist-progress-fill" style={{ width: `${progressPct}%` }} />
                            </div>

                            <div className="checklist-list">
                              {checklist.slice(0, 4).map((task) => (
                                <div
                                  key={task.id}
                                  className={`checklist-item ${task.completed ? "done" : ""}`}
                                  onClick={(e) => toggleChecklistItem(card, task.id, e)}
                                >
                                  <div className="checklist-checkbox">
                                    {task.completed && <Check size={9} strokeWidth={3} />}
                                  </div>
                                  <span className="checklist-label">{task.title}</span>
                                </div>
                              ))}
                              {checklist.length > 4 && (
                                <div
                                  style={{ fontSize: "10px", color: "var(--text-3)", cursor: "pointer", marginTop: "2px" }}
                                  onClick={() => setActiveDrawerHackathon(card)}
                                >
                                  +{checklist.length - 4} more follow-up tasks ➔
                                </div>
                              )}
                            </div>

                            {/* Inline Add Task */}
                            <div className="checklist-inline-add">
                              <input
                                type="text"
                                placeholder="+ New follow-up gate..."
                                value={quickTaskTexts[card.id] || ""}
                                onChange={(e) =>
                                  setQuickTaskTexts({ ...quickTaskTexts, [card.id]: e.target.value })
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    addChecklistItem(card, quickTaskTexts[card.id] || "");
                                  }
                                }}
                                className="checklist-inline-input"
                              />
                              <button
                                className="checklist-inline-btn"
                                onClick={() => addChecklistItem(card, quickTaskTexts[card.id] || "")}
                              >
                                Add
                              </button>
                            </div>
                          </div>

                          {/* Deliverables Lockbox (Deck, Repo, Demo, Portal) */}
                          <div className="deliverable-lockbox">
                            <Tip text={card.deckUrl ? "Open Slide Deck / PPT" : "Missing Deck link"}>
                              {card.deckUrl ? (
                                <a href={card.deckUrl} target="_blank" rel="noreferrer" className="lock-item active">
                                  <FileText size={12} /> Deck
                                </a>
                              ) : (
                                <button className="lock-item empty" onClick={() => setEditingCard(card)}>
                                  <FileText size={12} /> +Deck
                                </button>
                              )}
                            </Tip>

                            <Tip text={card.repoUrl ? "Open GitHub Repo" : "Missing GitHub link"}>
                              {card.repoUrl ? (
                                <a href={card.repoUrl} target="_blank" rel="noreferrer" className="lock-item active">
                                  <Code2 size={12} /> Repo
                                </a>
                              ) : (
                                <button className="lock-item empty" onClick={() => setEditingCard(card)}>
                                  <Code2 size={12} /> +Repo
                                </button>
                              )}
                            </Tip>

                            <Tip text={card.demoUrl ? "Open Video Demo (Loom/YouTube)" : "Missing Demo link"}>
                              {card.demoUrl ? (
                                <a href={card.demoUrl} target="_blank" rel="noreferrer" className="lock-item active">
                                  <Video size={12} /> Demo
                                </a>
                              ) : (
                                <button className="lock-item empty" onClick={() => setEditingCard(card)}>
                                  <Video size={12} /> +Demo
                                </button>
                              )}
                            </Tip>

                            <Tip text={card.submissionUrl || card.link ? "Open Submission Portal" : "Missing portal link"}>
                              {card.submissionUrl || card.link ? (
                                <a
                                  href={card.submissionUrl || card.link!}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="lock-item active"
                                >
                                  <Globe size={12} /> Portal
                                </a>
                              ) : (
                                <button className="lock-item empty" onClick={() => setEditingCard(card)}>
                                  <Globe size={12} /> +Portal
                                </button>
                              )}
                            </Tip>
                          </div>

                          {/* Squad Mode: Registrar and Teammates */}
                          {!isSolo && (
                            <div className="squad-info-strip">
                              <span className="registrar-pill" title="Who registered us">
                                👤 {card.registrar ? `Reg: ${card.registrar}` : "Registrar unassigned"}
                              </span>
                              {card.teammates && card.teammates.length > 0 && (
                                <span
                                  className="teammates-count"
                                  title={card.teammates.map((t) => `${t.name} (${t.role})`).join(", ")}
                                >
                                  +{card.teammates.length} squad
                                </span>
                              )}
                            </div>
                          )}

                          {/* Latest Update / Blocker Banner */}
                          {card.latestUpdate && (
                            <div
                              className={`card-update-preview ${card.latestUpdate.badge === "blocker" ? "blocker-glow" : ""}`}
                              onClick={() => setActiveDrawerHackathon(card)}
                            >
                              <span className={`update-badge-tag ${card.latestUpdate.badge}`}>
                                {card.latestUpdate.badge === "blocker"
                                  ? "🚨 BLOCKER"
                                  : card.latestUpdate.badge === "milestone"
                                    ? "🎯 MILESTONE"
                                    : "⚡ UPDATE"}
                              </span>
                              <span className="update-body-text">{card.latestUpdate.body}</span>
                            </div>
                          )}

                          {/* Registrants & Sync */}
                          <div className="card-registrants-row">
                            <span className="reg-count">
                              <Users size={12} />{" "}
                              {card.registrantsCount > 0
                                ? `${card.registrantsCount.toLocaleString()} hackers`
                                : "Auto-syncing"}
                            </span>
                            <Tip text="Refresh live registrants count">
                              <button className="sync-btn" onClick={() => refreshRegistrants(card.id)}>
                                <RefreshCw size={11} />
                              </button>
                            </Tip>
                          </div>

                          {/* Card Footer Actions */}
                          <div className="card-actions-row">
                            <button
                              className="card-action-btn updates-btn"
                              onClick={() => setActiveDrawerHackathon(card)}
                              title="Open live updates and comments feed"
                            >
                              <MessageSquare size={12} /> Feed ({card.updatesCount ?? 0})
                            </button>

                            <div className="phase-mover-group">
                              {phase.id !== "targeting" && (
                                <Tip text="Move back to previous phase">
                                  <button className="card-action-btn icon-btn" onClick={() => movePhase(card, "prev")}>
                                    <ArrowLeft size={12} />
                                  </button>
                                </Tip>
                              )}
                              {phase.id !== "won" && (
                                <Tip text="Advance to next phase gate">
                                  <button
                                    className="card-action-btn icon-btn primary"
                                    onClick={() => movePhase(card, "next")}
                                  >
                                    <ArrowRight size={12} />
                                  </button>
                                </Tip>
                              )}
                              <Tip text="Edit hackathon details, track & deliverables">
                                <button
                                  className="card-action-btn icon-btn"
                                  onClick={() => setEditingCard(card)}
                                >
                                  <Pencil size={11} />
                                </button>
                              </Tip>
                              <Tip text="Delete hackathon">
                                <button
                                  className="card-action-btn icon-btn delete"
                                  onClick={() => deleteHackathon(card.id, card.name)}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </Tip>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* LIVE UPDATES & FOLLOW-UP GATES DRAWER */}
        {activeDrawerHackathon && (
          <div className="gauntlet-drawer-overlay" onClick={() => setActiveDrawerHackathon(null)}>
            <div className="gauntlet-drawer" onClick={(e) => e.stopPropagation()}>
              <div className="drawer-header">
                <div>
                  <div className="drawer-pretitle">{activeDrawerHackathon.organizer || "Hackathon"} War-Room</div>
                  <h3 className="drawer-title">{activeDrawerHackathon.name}</h3>
                </div>
                <button className="drawer-close-btn" onClick={() => setActiveDrawerHackathon(null)}>
                  <X size={16} />
                </button>
              </div>

              {/* Quick Deliverable Summary */}
              <div className="drawer-links-strip">
                {activeDrawerHackathon.deckUrl && (
                  <a href={activeDrawerHackathon.deckUrl} target="_blank" rel="noreferrer" className="drawer-link-pill">
                    <FileText size={13} /> Slide Deck ↗
                  </a>
                )}
                {activeDrawerHackathon.repoUrl && (
                  <a href={activeDrawerHackathon.repoUrl} target="_blank" rel="noreferrer" className="drawer-link-pill">
                    <Code2 size={13} /> Repository ↗
                  </a>
                )}
                {activeDrawerHackathon.demoUrl && (
                  <a href={activeDrawerHackathon.demoUrl} target="_blank" rel="noreferrer" className="drawer-link-pill">
                    <Video size={13} /> Demo Video ↗
                  </a>
                )}
              </div>

              {/* COMPLETE FOLLOW-UP CHECKLIST IN DRAWER */}
              <div style={{ margin: "14px 0", background: "var(--sunken)", padding: "12px", borderRadius: "8px" }}>
                <h5 style={{ margin: "0 0 8px", fontSize: "12px", fontWeight: 750, color: "var(--text)" }}>
                  ✅ Follow-Up Gate Deliverables
                </h5>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {(activeDrawerHackathon.checklist ?? []).map((t) => (
                    <div
                      key={t.id}
                      className={`checklist-item ${t.completed ? "done" : ""}`}
                      onClick={() => toggleChecklistItem(activeDrawerHackathon, t.id)}
                    >
                      <div className="checklist-checkbox">
                        {t.completed && <Check size={9} strokeWidth={3} />}
                      </div>
                      <span className="checklist-label" style={{ fontSize: "12px" }}>
                        {t.title}
                      </span>
                      {t.assignedTo && (
                        <span style={{ fontSize: "10px", color: "var(--text-3)", marginLeft: "auto" }}>
                          @{t.assignedTo}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Post Update Form */}
              <form onSubmit={postUpdate} className="drawer-post-form">
                <div className="form-badge-selector">
                  <span className="badge-selector-label">Status Type:</span>
                  <button
                    type="button"
                    className={`badge-option update ${newUpdateBadge === "update" ? "selected" : ""}`}
                    onClick={() => setNewUpdateBadge("update")}
                  >
                    ⚡ Progress
                  </button>
                  <button
                    type="button"
                    className={`badge-option blocker ${newUpdateBadge === "blocker" ? "selected" : ""}`}
                    onClick={() => setNewUpdateBadge("blocker")}
                  >
                    🚨 Blocker
                  </button>
                  <button
                    type="button"
                    className={`badge-option milestone ${newUpdateBadge === "milestone" ? "selected" : ""}`}
                    onClick={() => setNewUpdateBadge("milestone")}
                  >
                    🎯 Milestone
                  </button>
                  <button
                    type="button"
                    className={`badge-option submission ${newUpdateBadge === "submission" ? "selected" : ""}`}
                    onClick={() => setNewUpdateBadge("submission")}
                  >
                    🚀 Submission
                  </button>
                </div>

                <div className="form-author-row">
                  <input
                    type="text"
                    placeholder="Your name or handle..."
                    value={newUpdateAuthor}
                    onChange={(e) => setNewUpdateAuthor(e.target.value)}
                    className="author-input"
                  />
                </div>

                <div className="form-textarea-row">
                  <textarea
                    placeholder="Log what you built, what is blocked, or submission links..."
                    value={newUpdateBody}
                    onChange={(e) => setNewUpdateBody(e.target.value)}
                    rows={3}
                    className="update-textarea"
                    required
                  />
                </div>

                <div className="form-actions-row">
                  <button type="submit" className="btn primary" disabled={isSubmittingUpdate || !newUpdateBody.trim()}>
                    <Send size={13} /> {isSubmittingUpdate ? "Logging..." : "Log to Feed"}
                  </button>
                </div>
              </form>

              {/* Feed of updates */}
              <div className="drawer-updates-feed">
                <h5 className="feed-header">Execution Feed & Timeline</h5>
                <div className="feed-list">
                  {activeDrawerHackathon.latestUpdate ? (
                    <div className="feed-item">
                      <div className="feed-item-header">
                        <span className={`feed-badge ${activeDrawerHackathon.latestUpdate.badge}`}>
                          {activeDrawerHackathon.latestUpdate.badge.toUpperCase()}
                        </span>
                        <span className="feed-author">{activeDrawerHackathon.latestUpdate.authorName}</span>
                        <span className="feed-time">
                          {new Date(activeDrawerHackathon.latestUpdate.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <div className="feed-body">{activeDrawerHackathon.latestUpdate.body}</div>
                    </div>
                  ) : (
                    <div className="feed-empty">
                      <span>No timeline logs yet. Post an update or blocker above!</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* EDIT / CREATE HACKATHON MODAL */}
        {editingCard && (
          <div className="gauntlet-modal-overlay" onClick={() => setEditingCard(null)}>
            <div className="gauntlet-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3>{editingCard.id ? "Edit Hackathon Campaign" : "New Hackathon Campaign"}</h3>
                <button className="modal-close-btn" onClick={() => setEditingCard(null)}>
                  <X size={16} />
                </button>
              </div>

              <form onSubmit={saveCard} className="modal-form">
                <div className="form-row">
                  <label>
                    Hackathon Title *
                    <input
                      type="text"
                      placeholder="e.g. ETHGlobal Tokyo, Devfolio Build, Unstop AI Sprint"
                      value={editingCard.name ?? ""}
                      onChange={(e) => setEditingCard({ ...editingCard, name: e.target.value })}
                      required
                    />
                  </label>
                </div>

                <div className="form-row two-col">
                  <label>
                    Phase Gate
                    <select
                      value={editingCard.phase ?? "targeting"}
                      onChange={(e) => setEditingCard({ ...editingCard, phase: e.target.value as GauntletPhase })}
                    >
                      {PHASES.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Prize Pool
                    <input
                      type="text"
                      placeholder="e.g. $50,000 or ₹10,00,000"
                      value={editingCard.prizePool ?? ""}
                      onChange={(e) => setEditingCard({ ...editingCard, prizePool: e.target.value })}
                    />
                  </label>
                </div>

                <div className="form-row two-col">
                  <label>
                    Submission Deadline
                    <input
                      type="datetime-local"
                      value={editingCard.submitDeadline ? editingCard.submitDeadline.slice(0, 16) : ""}
                      onChange={(e) => setEditingCard({ ...editingCard, submitDeadline: e.target.value })}
                    />
                  </label>
                  <label>
                    Target Track
                    <input
                      type="text"
                      placeholder="e.g. AI Agents, Web3 Infra, HealthTech"
                      value={editingCard.track ?? ""}
                      onChange={(e) => setEditingCard({ ...editingCard, track: e.target.value })}
                    />
                  </label>
                </div>

                <div className="form-row two-col">
                  <label>
                    Organizer / Platform
                    <input
                      type="text"
                      placeholder="e.g. Devpost, DoraHacks, Unstop, MLH"
                      value={editingCard.organizer ?? ""}
                      onChange={(e) => setEditingCard({ ...editingCard, organizer: e.target.value })}
                    />
                  </label>
                  <label>
                    Registrar (Who registered?)
                    <input
                      type="text"
                      placeholder="e.g. Alex (alex@team.com)"
                      value={editingCard.registrar ?? ""}
                      onChange={(e) => setEditingCard({ ...editingCard, registrar: e.target.value })}
                    />
                  </label>
                </div>

                {/* DELIVERABLE LOCKBOX SECTION */}
                <div className="form-section-title">
                  <ShieldCheck size={14} /> Deliverable Lockbox (Live links prevent 11th-hour scramble)
                </div>

                <div className="form-row two-col">
                  <label>
                    📊 Slide Deck / PPT Link
                    <input
                      type="url"
                      placeholder="https://docs.google.com/presentation/..."
                      value={editingCard.deckUrl ?? ""}
                      onChange={(e) => setEditingCard({ ...editingCard, deckUrl: e.target.value })}
                    />
                  </label>
                  <label>
                    💻 GitHub Repo Link
                    <input
                      type="url"
                      placeholder="https://github.com/org/repo"
                      value={editingCard.repoUrl ?? ""}
                      onChange={(e) => setEditingCard({ ...editingCard, repoUrl: e.target.value })}
                    />
                  </label>
                </div>

                <div className="form-row two-col">
                  <label>
                    🎥 Video Demo Link (Loom / YouTube)
                    <input
                      type="url"
                      placeholder="https://loom.com/share/..."
                      value={editingCard.demoUrl ?? ""}
                      onChange={(e) => setEditingCard({ ...editingCard, demoUrl: e.target.value })}
                    />
                  </label>
                  <label>
                    🌐 Final Submission Portal URL
                    <input
                      type="url"
                      placeholder="https://devpost.com/software/..."
                      value={editingCard.submissionUrl ?? editingCard.link ?? ""}
                      onChange={(e) =>
                        setEditingCard({ ...editingCard, submissionUrl: e.target.value, link: e.target.value })
                      }
                    />
                  </label>
                </div>

                <div className="form-row">
                  <label>
                    Notes & Requirements
                    <textarea
                      rows={2}
                      placeholder="Submission rules, API credits provided, offline venue details..."
                      value={editingCard.notes ?? ""}
                      onChange={(e) => setEditingCard({ ...editingCard, notes: e.target.value })}
                    />
                  </label>
                </div>

                <div className="modal-actions" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  {editingCard.id ? (
                    <button
                      type="button"
                      className="btn danger"
                      onClick={() => {
                        if (editingCard.id && editingCard.name) {
                          deleteHackathon(editingCard.id, editingCard.name);
                          setEditingCard(null);
                        }
                      }}
                    >
                      <Trash2 size={13} /> Delete Event
                    </button>
                  ) : <div />}
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button type="button" className="btn" onClick={() => setEditingCard(null)}>
                      Cancel
                    </button>
                    <button type="submit" className="btn primary">
                      {editingCard.id ? "Save Changes" : "Create Card"}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* 1-CLICK IMPORT MODAL FROM DIG DISCOVERY */}
        {importModalOpen && (
          <div className="gauntlet-modal-overlay" onClick={() => setImportModalOpen(false)}>
            <div className="gauntlet-modal wide" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <div>
                  <div className="modal-badge">
                    <Sparkles size={13} /> Dig Intelligence Pipeline
                  </div>
                  <h3>Import Discovered Hackathons</h3>
                </div>
                <button className="modal-close-btn" onClick={() => setImportModalOpen(false)}>
                  <X size={16} />
                </button>
              </div>

              <div className="modal-body-scroll">
                <p className="import-subtitle">
                  These hackathons were uncovered by Dig’s search intelligence across Devpost, DoraHacks, Unstop, and
                  ETHGlobal. Click import to track them directly inside <strong>{activeRoom?.name}</strong> with zero
                  manual data entry.
                </p>

                {availableEventsData?.events && availableEventsData.events.length > 0 ? (
                  <div className="import-grid">
                    {availableEventsData.events.map((ev, i) => (
                      <div key={i} className="import-card">
                        <div className="import-card-header">
                          <span className="import-organizer">{ev.organizer}</span>
                          {ev.prizePool && <span className="import-prize">{ev.prizePool}</span>}
                        </div>
                        {ev.mainPanelEvent && (
                          <div className="import-source-badge">
                            <Sparkles size={10} /> Main Panel: {ev.mainPanelEvent}
                          </div>
                        )}
                        <h4 className="import-title">{ev.name}</h4>
                        {ev.dates && <div className="import-dates">📅 {ev.dates}</div>}
                        {ev.track && <div className="import-track">Tracks: {ev.track}</div>}
                        <div className="import-card-footer">
                          <button className="btn primary small" onClick={() => importDiscoveredEvent(ev)}>
                            <Plus size={12} /> Import to {activeRoom?.name}
                          </button>
                          {ev.website && (
                            <a href={ev.website} target="_blank" rel="noreferrer" className="import-link">
                              Event Link ↗
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="import-empty">
                    <Sparkles size={32} className="empty-sparkle" />
                    <h4>No Hackathon Datasets Found Yet</h4>
                    <p>
                      Run a hackathon search from Dig's main panel (e.g. <strong>"AI hackathons with prize money"</strong>). Dig
                      will extract the full dates, tracks, and prize pools from the main panel, and they’ll automatically
                      appear here for 1-click import into this room!
                    </p>
                    <button
                      className="btn primary"
                      onClick={() => {
                        setImportModalOpen(false);
                        setEditingCard({ phase: "targeting", teammates: [], tags: [], roomId: currentRoomId });
                      }}
                    >
                      <Plus size={14} /> Add Custom Hackathon Instead
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        </div>
      </div>
    </AppWindow>
  );
}
