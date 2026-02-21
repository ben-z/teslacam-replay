import { useState, useEffect, useCallback, useMemo, useRef, Component } from "react";
import type { ReactNode } from "react";
import { fetchEvents, refreshEvents } from "./api";
import { EventBrowser } from "./components/EventBrowser";
import { Player } from "./components/Player";
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
    return <div key={this.state.resetKey}>{this.props.children}</div>;
  }
}

// Parse hash: "#/event/SavedClips/2025-..." -> { type, id }
function parseHash(): { type: string; id: string } | null {
  const m = location.hash.match(/^#\/event\/(SavedClips|SentryClips|RecentClips)\/(.+)$/);
  return m ? { type: m[1], id: m[2] } : null;
}

const WATCHED_KEY = "dashreplay-watched";
function loadWatched(): Set<string> {
  try {
    const raw = localStorage.getItem(WATCHED_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}
function saveWatched(ids: Set<string>) {
  try {
    localStorage.setItem(WATCHED_KEY, JSON.stringify([...ids]));
  } catch { /* storage full or unavailable */ }
}

export function App() {
  const [events, setEvents] = useState<DashcamEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(() =>
    parseHash() ? "player" : "browse"
  );
  const [selectedEvent, setSelectedEvent] = useState<DashcamEvent | null>(null);
  // The filtered list of events the user was browsing when they selected an event
  const [browseList, setBrowseList] = useState<DashcamEvent[]>([]);
  const [watchedIds, setWatchedIds] = useState<Set<string>>(loadWatched);
  const pushedHashRef = useRef(false);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchEvents();
      setEvents(data);
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

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

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

  const clearWatched = useCallback(() => {
    setWatchedIds(new Set());
    saveWatched(new Set());
  }, []);

  const markWatched = useCallback((event: DashcamEvent) => {
    const key = `${event.type}/${event.id}`;
    setWatchedIds((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev).add(key);
      saveWatched(next);
      return next;
    });
  }, []);

  const handleSelectEvent = (event: DashcamEvent, filteredList?: DashcamEvent[]) => {
    setSelectedEvent(event);
    setView("player");
    if (filteredList) setBrowseList(filteredList);
    markWatched(event);
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
        markWatched(next);
        // Replace hash (don't push, so back goes to browse not previous event)
        history.replaceState(null, "", `#/event/${next.type}/${next.id}`);
      }
    },
    [navList, selectedIdx, markWatched]
  );

  return (
    <ErrorBoundary>
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        {view === "browse" ? (
          <EventBrowser
            events={events}
            loading={loading}
            error={error}
            watchedIds={watchedIds}
            onSelectEvent={handleSelectEvent}
            onRefresh={handleRefresh}
            onClearWatched={clearWatched}
          />
        ) : selectedEvent ? (
          <Player
            event={selectedEvent}
            onBack={handleBack}
            onNavigate={handleNavigate}
            hasPrev={selectedIdx > 0}
            hasNext={selectedIdx < navList.length - 1}
          />
        ) : null}
      </div>
    </ErrorBoundary>
  );
}
