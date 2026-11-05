import { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore, Component, lazy, Suspense } from "react";
import type { ReactNode } from "react";
import { fetchEvent } from "./api";
import { archiveEvents, RecordingArchive } from "./recordingArchive";
import type { ArchiveDayKey } from "./archive";
import { EventBrowser } from "./components/EventBrowser";
import type { DashcamEvent, ViewMode } from "./types";
import { compareRecordingOrder } from "./events";

const loadPlayer = () => import("./components/Player");
const Player = lazy(async () => ({ default: (await loadPlayer()).Player }));

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

export function App() {
  const [recordings] = useState(() => new RecordingArchive());
  const archive = useSyncExternalStore(recordings.subscribe, recordings.getSnapshot);
  const events = useMemo(() => archiveEvents(archive), [archive.days, archive.details]);
  const [eventError, setEventError] = useState<string | null>(null);
  const routeRequest = useRef(0);
  const [view, setView] = useState<ViewMode>(() =>
    parseHash() ? "player" : "browse"
  );
  const [selectedEvent, setSelectedEvent] = useState<DashcamEvent | null>(null);
  const [initialTime, setInitialTime] = useState(0);
  const pendingStartTime = useRef<{ type: string; id: string; captureTimeMs: number } | null>(null);
  // The filtered list of events the user was browsing when they selected an event
  const [browseList, setBrowseList] = useState<DashcamEvent[]>([]);
  const pushedHashRef = useRef(false);
  const browseFocusRef = useRef<HTMLElement | null>(null);
  const recordingBackRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (view !== "browse") return;
    const opener = browseFocusRef.current;
    browseFocusRef.current = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }, [view]);

  useEffect(() => {
    if (view !== "player" || selectedEvent || !document.hasFocus()) return;
    if (document.activeElement === document.body || document.activeElement === browseFocusRef.current) {
      recordingBackRef.current?.focus({ preventScroll: true });
    }
  }, [view, selectedEvent, eventError]);

  const selectEvent = useCallback((event: DashcamEvent) => {
    setSelectedEvent(event);
    setView("player");
  }, []);

  const loadRoute = useCallback(async (route: { type: string; id: string }, refresh: boolean) => {
    const request = ++routeRequest.current;
    const pending = pendingStartTime.current;
    const requestedCaptureTime = pending?.type === route.type && pending.id === route.id ? pending.captureTimeMs : undefined;
    if (requestedCaptureTime === undefined) pendingStartTime.current = null;
    setView("player");
    setSelectedEvent(null);
    setEventError(null);
    try {
      const [found] = await Promise.all([fetchEvent(route.type, route.id, refresh), loadPlayer()]);
      if (request !== routeRequest.current) return;
      recordings.rememberRecording(found);
      const canonical = archiveEvents(recordings.getSnapshot()).find((event) => event.type === found.type && event.id === found.id);
      if (!canonical) throw new Error("Loaded recording is missing from the event list");
      history.replaceState(null, "", `#/event/${canonical.type}/${canonical.id}`);
      setInitialTime(requestedCaptureTime === undefined ? 0 : Math.max(0,
        (requestedCaptureTime - canonical.clips[0].captureTimeMs) / 1000));
      pendingStartTime.current = null;
      selectEvent(canonical);
    } catch (error) {
      if (request === routeRequest.current) {
        setEventError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [selectEvent, recordings]);

  useEffect(() => {
    if (view === "browse") void recordings.start();
  }, [view, recordings]);

  useEffect(() => {
    const onHashChange = () => {
      const route = parseHash();
      if (route) {
        void loadRoute(route, false);
      } else {
        routeRequest.current++;
        pendingStartTime.current = null;
        setSelectedEvent(null);
        setView("browse");
      }
    };
    onHashChange();
    window.addEventListener("hashchange", onHashChange);
    return () => {
      routeRequest.current++;
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [loadRoute]);

  const handleLoadDays = useCallback((days: ArchiveDayKey[], refresh: boolean) => {
    for (const day of days) void recordings.loadDay(day, refresh);
  }, [recordings]);

  const handleSelectEvent = (event: DashcamEvent, filteredList?: DashcamEvent[], startTime?: number) => {
    pendingStartTime.current = startTime === undefined ? null : {
      type: event.type,
      id: event.id,
      captureTimeMs: event.clips[0].captureTimeMs + startTime * 1000,
    };
    if (view === "browse" && document.activeElement instanceof HTMLElement) {
      browseFocusRef.current = document.activeElement;
    }
    if (filteredList) setBrowseList(filteredList);
    const hash = `#/event/${event.type}/${event.id}`;
    if (location.hash === hash) {
      void loadRoute(event, false);
    } else {
      pushedHashRef.current = true;
      location.hash = hash;
    }
  };

  const handleBack = () => {
    pendingStartTime.current = null;
    if (pushedHashRef.current) {
      // We pushed a hash, so history.back() returns to browse
      pushedHashRef.current = false;
      history.back();
    } else {
      // Direct load via URL or navigation - just go to browse
      routeRequest.current++;
      setSelectedEvent(null);
      setView("browse");
      history.replaceState(null, "", location.pathname + location.search);
    }
  };

  // Navigation uses the filtered list the user was browsing
  const navList = useMemo(() => {
    const visible = browseList.length === 0 ? events : events.filter((current) =>
      browseList.some((event) => current.type === event.type && (
        current.id === event.id || (current.type === "RecentClips" && event.clips.some((clip) =>
          current.clips.some((candidate) => candidate.timestamp === clip.timestamp)
        ))
      ))
    );
    return [...visible].sort(compareRecordingOrder);
  }, [browseList, events]);

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
        pendingStartTime.current = null;
        history.replaceState(null, "", `#/event/${next.type}/${next.id}`);
        void loadRoute(next, false);
      }
    },
    [navList, selectedIdx, loadRoute]
  );

  return (
    <ErrorBoundary>
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div hidden={view !== "browse"} style={{ height: "100%" }}>
          <EventBrowser
            active={view === "browse"}
            events={events}
            archive={archive}
            onSelectEvent={handleSelectEvent}
            onRefresh={recordings.refresh}
            onLoadCatalog={recordings.loadCatalog}
            onLoadDays={handleLoadDays}
          />
        </div>
        {view === "player" && (selectedEvent ? (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
            <Suspense fallback={<div className="event-loading" role="status">Loading player…</div>}>
              <Player
                event={selectedEvent}
                initialTime={initialTime}
                onBack={handleBack}
                onRefresh={() => { void loadRoute(selectedEvent, true); }}
                onNavigate={handleNavigate}
                hasPrev={selectedIdx > 0}
                hasNext={selectedIdx < navList.length - 1}
              />
            </Suspense>
          </div>
        ) : (
          <div className="event-loading" role="status">
            <p>{eventError ?? "Loading recording…"}</p>
            {eventError && <button onClick={() => { const route = parseHash(); if (route) void loadRoute(route, true); }}>Retry recording</button>}
            {eventError && <button onClick={() => location.reload()}>Reload app</button>}
            <button ref={recordingBackRef} onClick={handleBack}>Back to recordings</button>
          </div>
        ))}
      </div>
    </ErrorBoundary>
  );
}
