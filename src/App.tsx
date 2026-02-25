import { useState, useEffect, useCallback, useMemo, useRef, Component } from "react";
import type { ReactNode } from "react";
import { fetchEvents, refreshEvents, fetchStatus, type ServerStatus } from "./api";
import { EventBrowser } from "./components/EventBrowser";
import { Player } from "./components/Player";
import { Timeline } from "./components/Timeline";
import { SetupScreen } from "./components/SetupScreen";
import type { DashcamEvent, ViewMode } from "./types";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; resetKey: number }
> {
  state: { error: Error | null; resetKey: number } = { error: null, resetKey: 0 };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, color: "#f87171", textAlign: "center" }}>
          <h2>Something went wrong</h2>
          <p style={{ color: "#999", fontSize: 14 }}>
            {this.state.error.message}
          </p>
          <button
            onClick={() => this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }))}
            style={{
              marginTop: 16,
              padding: "8px 16px",
              background: "#333",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    // Key change forces children to fully remount, clearing any corrupted state
    return <div key={this.state.resetKey} style={{ height: "100%" }}>{this.props.children}</div>;
  }
}

// Parse hash: "#/event/SavedClips/2025-..." -> { type, id }
function parseHash(): { type: string; id: string } | null {
  const m = location.hash.match(/^#\/event\/(SavedClips|SentryClips|RecentClips)\/(.+)$/);
  return m ? { type: m[1], id: m[2] } : null;
}

const EVENTS_CACHE_KEY = "teslacam-replay:events";

function cacheEvents(data: DashcamEvent[]): void {
  try { localStorage.setItem(EVENTS_CACHE_KEY, JSON.stringify(data)); } catch {}
}

function loadCachedEvents(): DashcamEvent[] {
  try {
    const cached = localStorage.getItem(EVENTS_CACHE_KEY);
    return cached ? JSON.parse(cached) : [];
  } catch {
    return [];
  }
}

export function App() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [events, setEvents] = useState<DashcamEvent[]>(loadCachedEvents);
  const [loading, setLoading] = useState(events.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(() =>
    parseHash() ? "player" : "browse"
  );
  const [selectedEvent, setSelectedEvent] = useState<DashcamEvent | null>(null);
  // The filtered list of events the user was browsing when they selected an event
  const [browseList, setBrowseList] = useState<DashcamEvent[]>([]);
  const [playerDisplayTime, setPlayerDisplayTime] = useState(0);
  const [playerIsPlaying, setPlayerIsPlaying] = useState(false);
  const pushedHashRef = useRef(false);

  const loadEvents = useCallback(async () => {
    setError(null);
    try {
      const data = await fetchEvents();
      setEvents(data);
      cacheEvents(data);
      // Restore event from URL hash after initial load
      const hashEvent = parseHash();
      if (hashEvent) {
        const found = data.find(
          (e) => e.type === hashEvent.type && e.id === hashEvent.id
        );
        if (found) {
          setSelectedEvent(found);
          setView("player");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load events");
    } finally {
      setLoading(false);
    }
  }, []);

  const checkStatus = useCallback(() => {
    fetchStatus().then((s) => {
      setStatus(s);
      if (s.connected) loadEvents();
      else setLoading(false);
    }).catch(() => setLoading(false));
  }, [loadEvents]);

  // Check server status on mount to determine if setup is needed
  useEffect(() => { checkStatus(); }, [checkStatus]);

  // Auto-refresh: poll for new events every 30s while browsing
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  useEffect(() => {
    if (view !== "browse" || !status?.connected) return;
    const interval = setInterval(async () => {
      if (loadingRef.current) return;
      try {
        const data = await fetchEvents();
        let updated = false;
        setEvents((prev) => {
          if (data.length === prev.length) return prev;
          updated = true;
          return data;
        });
        if (updated) cacheEvents(data);
      } catch {
        // silent -- manual refresh still available
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [view, status?.connected]);

  // Sync URL hash with browser back/forward
  useEffect(() => {
    const onHashChange = () => {
      const hashEvent = parseHash();
      if (hashEvent) {
        const found = events.find(
          (e) => e.type === hashEvent.type && e.id === hashEvent.id
        );
        if (found) {
          setSelectedEvent(found);
          setView("player");
          return;
        }
      }
      setSelectedEvent(null);
      setView("browse");
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [events]);

  const handleRefresh = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const data = await refreshEvents();
      setEvents(data);
      cacheEvents(data);
      // Clear stale browse list so navigation uses fresh event objects
      setBrowseList([]);
      // Update selectedEvent to new reference if still viewing one
      setSelectedEvent((prev) => {
        if (!prev) return null;
        return data.find((e) => e.type === prev.type && e.id === prev.id) ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh");
    } finally {
      setLoading(false);
    }
  };

  const handleSelectEvent = (event: DashcamEvent, filteredList?: DashcamEvent[]) => {
    setSelectedEvent(event);
    setView("player");
    if (filteredList) setBrowseList(filteredList);
    pushedHashRef.current = true;
    location.hash = `/event/${event.type}/${event.id}`;
  };

  const handleBack = () => {
    if (pushedHashRef.current) {
      // We pushed a hash, so history.back() returns to browse
      pushedHashRef.current = false;
      history.back();
    } else {
      // Direct load via URL or navigation - just go to browse
      setSelectedEvent(null);
      setView("browse");
      history.replaceState(null, "", location.pathname);
    }
  };

  // Navigation uses the filtered list the user was browsing
  const navList = browseList.length > 0 ? browseList : events;

  const selectedIdx = useMemo(() => {
    if (!selectedEvent) return -1;
    return navList.findIndex(
      (e) => e.type === selectedEvent.type && e.id === selectedEvent.id
    );
  }, [navList, selectedEvent]);

  const handleNavigate = useCallback(
    (direction: -1 | 1) => {
      const nextIdx = selectedIdx + direction;
      if (nextIdx >= 0 && nextIdx < navList.length) {
        const next = navList[nextIdx];
        setSelectedEvent(next);
        // Replace hash (don't push, so back goes to browse not previous event)
        history.replaceState(null, "", `#/event/${next.type}/${next.id}`);
      }
    },
    [navList, selectedIdx]
  );

  const handleTimeUpdate = useCallback((time: number, playing: boolean) => {
    setPlayerDisplayTime(time);
    setPlayerIsPlaying(playing);
  }, []);

  const handleSetupComplete = () => {
    setStatus(null);
    checkStatus();
  };

  // Show setup screen when server reports not connected
  if (status && !status.connected) {
    return (
      <ErrorBoundary>
        <SetupScreen setupStep={status.setupStep} onComplete={handleSetupComplete} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        {view === "browse" ? (
          <EventBrowser
            events={events}
            loading={loading}
            error={error}
            onSelectEvent={handleSelectEvent}
            onRefresh={handleRefresh}
          />
        ) : selectedEvent ? (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
            <Player
              event={selectedEvent}
              onBack={handleBack}
              onNavigate={handleNavigate}
              hasPrev={selectedIdx > 0}
              hasNext={selectedIdx < navList.length - 1}
              onTimeUpdate={handleTimeUpdate}
            />
            {selectedEvent.type === "RecentClips" && (
              <Timeline
                events={events}
                selectedEvent={selectedEvent}
                displayTime={playerDisplayTime}
                isPlaying={playerIsPlaying}
                onSelectEvent={handleSelectEvent}
                compact
              />
            )}
          </div>
        ) : null}
      </div>
    </ErrorBoundary>
  );
}
