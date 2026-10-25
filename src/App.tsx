import { useState, useEffect, useCallback, useMemo, useRef, Component, lazy, Suspense } from "react";
import type { ReactNode } from "react";
import {
  fetchEvent,
  fetchEventPage,
  EVENT_PAGE_TYPES,
  type EventPagePositions,
  type EventPageType,
} from "./api";
import { EventBrowser } from "./components/EventBrowser";
import type { DashcamEvent, ViewMode } from "./types";
import { mergeEvents, replaceEventSnapshot } from "./events";

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

const PAGE_LOAD_LIMIT = 24;
type PageRequest = { type: EventPageType; pageToken: string | null };
type PageLoadError = { message: string; pageToken: string | null };

export function App() {
  const [events, setEvents] = useState<DashcamEvent[]>([]);
  const [pendingTypes, setPendingTypes] = useState<EventPageType[]>(EVENT_PAGE_TYPES);
  const [pagePositions, setPagePositions] = useState<EventPagePositions>({});
  const [pageErrors, setPageErrors] = useState<Partial<Record<EventPageType, PageLoadError>>>({});
  const [eventError, setEventError] = useState<string | null>(null);
  const routeRequest = useRef(0);
  const browseRequested = useRef(false);
  const [view, setView] = useState<ViewMode>(() =>
    parseHash() ? "player" : "browse"
  );
  const [selectedEvent, setSelectedEvent] = useState<DashcamEvent | null>(null);
  // The filtered list of events the user was browsing when they selected an event
  const [browseList, setBrowseList] = useState<DashcamEvent[]>([]);
  const pushedHashRef = useRef(false);
  const browseFocusRef = useRef<HTMLElement | null>(null);
  const eventsRef = useRef(events);
  const pagePositionsRef = useRef(pagePositions);
  const pendingPageTypesRef = useRef(new Set<EventPageType>());
  eventsRef.current = events;
  pagePositionsRef.current = pagePositions;

  useEffect(() => {
    if (view !== "browse") return;
    const opener = browseFocusRef.current;
    browseFocusRef.current = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }, [view]);

  const selectEvent = useCallback((event: DashcamEvent) => {
    setSelectedEvent(event);
    setView("player");
  }, []);

  const loadRoute = useCallback(async (route: { type: string; id: string }, refresh: boolean) => {
    const request = ++routeRequest.current;
    setView("player");
    setSelectedEvent(null);
    setEventError(null);
    try {
      const [found] = await Promise.all([fetchEvent(route.type, route.id, refresh), loadPlayer()]);
      if (request !== routeRequest.current) return;
      const merged = refresh
        ? replaceEventSnapshot(eventsRef.current, found)
        : mergeEvents(eventsRef.current, [found]);
      setEvents(merged);
      eventsRef.current = merged;
      const canonical = merged.find((event) => event.type === found.type && event.id === found.id);
      if (!canonical) throw new Error("Loaded recording is missing from the event list");
      history.replaceState(null, "", `#/event/${canonical.type}/${canonical.id}`);
      selectEvent(canonical);
    } catch (error) {
      if (request === routeRequest.current) {
        setEventError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [selectEvent]);

  const loadPages = useCallback(async (pages: PageRequest[]) => {
    const requested: PageRequest[] = [];
    for (const page of pages) {
      if (pendingPageTypesRef.current.has(page.type)) continue;
      pendingPageTypesRef.current.add(page.type);
      requested.push(page);
    }
    if (requested.length === 0) return;
    const catalogAtStart = eventsRef.current;
    setPendingTypes([...pendingPageTypesRef.current]);
    setPageErrors((previous) => {
      const errors = { ...previous };
      for (const { type } of requested) delete errors[type];
      return errors;
    });
    await Promise.all(requested.map(async ({ type, pageToken }) => {
      try {
        const result = await fetchEventPage(type, pageToken, PAGE_LOAD_LIMIT);
        // Recording details loaded after this page began remain authoritative.
        const updatedRecordings = eventsRef.current.filter((event) =>
          event.type === type && !catalogAtStart.includes(event));
        const previous = pageToken === null
          ? eventsRef.current.filter((event) => event.type !== type)
          : eventsRef.current;
        const merged = updatedRecordings.reduce(replaceEventSnapshot, mergeEvents(previous, result.events));
        const nextPositions = {
          ...pagePositionsRef.current,
          [type]: { nextPageToken: result.nextPageToken, nextPageDate: result.nextPageDate },
        };
        eventsRef.current = merged;
        pagePositionsRef.current = nextPositions;
        setEvents(merged);
        setPagePositions(nextPositions);
      } catch (err) {
        setPageErrors((previous) => ({
          ...previous,
          [type]: { message: err instanceof Error ? err.message : String(err), pageToken },
        }));
      } finally {
        pendingPageTypesRef.current.delete(type);
        setPendingTypes([...pendingPageTypesRef.current]);
      }
    }));
  }, []);

  useEffect(() => {
    if (view === "browse" && !browseRequested.current) {
      browseRequested.current = true;
      void loadPages(EVENT_PAGE_TYPES.map((type) => ({ type, pageToken: null })));
    }
  }, [view, loadPages]);

  useEffect(() => {
    const onHashChange = () => {
      const route = parseHash();
      if (route) {
        void loadRoute(route, false);
      } else {
        routeRequest.current++;
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

  const handleRefresh = async () => {
    if (pendingPageTypesRef.current.size > 0) return;
    setBrowseList([]);
    await loadPages(EVENT_PAGE_TYPES.map((type) => ({ type, pageToken: null })));
  };

  const handleLoadMore = useCallback((types: EventPageType[]) => {
    const pages: PageRequest[] = [];
    for (const type of types) {
      const token = pagePositionsRef.current[type]?.nextPageToken;
      if (token && !pageErrors[type]) pages.push({ type, pageToken: token });
    }
    void loadPages(pages);
  }, [loadPages, pageErrors]);

  const handleRetry = (type: EventPageType) => {
    const error = pageErrors[type];
    if (error) {
      void loadPages([{ type, pageToken: error.pageToken }]);
    }
  };

  const handleSelectEvent = (event: DashcamEvent, filteredList?: DashcamEvent[]) => {
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
    return [...visible].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
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
            pendingTypes={pendingTypes}
            errorsByType={Object.fromEntries(Object.entries(pageErrors).map(([type, error]) => [type, error.message]))}
            onSelectEvent={handleSelectEvent}
            onRefresh={handleRefresh}
            onRetry={handleRetry}
            onLoadMore={handleLoadMore}
            pagePositions={pagePositions}
          />
        </div>
        {view === "player" && (selectedEvent ? (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
            <Suspense fallback={<div className="event-loading" role="status">Loading player…</div>}>
              <Player
                event={selectedEvent}
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
            <button onClick={handleBack}>Back to recordings</button>
          </div>
        ))}
      </div>
    </ErrorBoundary>
  );
}
