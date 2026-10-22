import { useState, useEffect, useCallback, useMemo, useRef, Component } from "react";
import type { ReactNode } from "react";
import {
  fetchEvent,
  fetchEventPage,
  type EventPageType,
} from "./api";
import { EventBrowser } from "./components/EventBrowser";
import { Player } from "./components/Player";
import { Timeline } from "./components/Timeline";
import type { DashcamEvent, ViewMode } from "./types";
import { mergeEvents, replaceEventSnapshot } from "./events";

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
const PAGE_TYPES: EventPageType[] = ["SavedClips", "SentryClips", "RecentClips"];
type PageTokens = Record<EventPageType, string | null>;
const EMPTY_PAGE_TOKENS: PageTokens = {
  SavedClips: null,
  SentryClips: null,
  RecentClips: null,
};

export function App() {
  const [events, setEvents] = useState<DashcamEvent[]>([]);
  const [loading, setLoading] = useState(events.length === 0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextPageTokens, setNextPageTokens] = useState<PageTokens>(EMPTY_PAGE_TOKENS);
  const [error, setError] = useState<string | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  const routeRequest = useRef(0);
  const pageRequest = useRef(0);
  const browseRequested = useRef(false);
  const [view, setView] = useState<ViewMode>(() =>
    parseHash() ? "player" : "browse"
  );
  const [selectedEvent, setSelectedEvent] = useState<DashcamEvent | null>(null);
  // The filtered list of events the user was browsing when they selected an event
  const [browseList, setBrowseList] = useState<DashcamEvent[]>([]);
  const [playerDisplayTime, setPlayerDisplayTime] = useState(0);
  const [playerIsPlaying, setPlayerIsPlaying] = useState(false);
  const pushedHashRef = useRef(false);
  const eventsRef = useRef(events);
  const nextPageTokensRef = useRef(nextPageTokens);
  const loadingMoreRef = useRef(loadingMore);
  eventsRef.current = events;
  nextPageTokensRef.current = nextPageTokens;
  loadingMoreRef.current = loadingMore;

  const selectEvent = useCallback((event: DashcamEvent) => {
    setSelectedEvent(event);
    setPlayerDisplayTime(0);
    setPlayerIsPlaying(false);
    setView("player");
  }, []);

  const loadRoute = useCallback(async (route: { type: string; id: string }, refresh: boolean) => {
    const request = ++routeRequest.current;
    pageRequest.current++;
    setLoading(false);
    setLoadingMore(false);
    loadingMoreRef.current = false;
    setView("player");
    setSelectedEvent(null);
    setEventError(null);
    try {
      const found = await fetchEvent(route.type, route.id, refresh);
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

  const loadPages = useCallback(async (
    types: EventPageType[],
    reset: boolean
  ) => {
    const request = ++pageRequest.current;
    setError(null);
    if (reset) setLoading(true);
    else setLoadingMore(true);
    try {
      const tokenSource = reset ? EMPTY_PAGE_TOKENS : nextPageTokensRef.current;
      const results = await Promise.all(
        types.map((type) => fetchEventPage(type, tokenSource[type], PAGE_LOAD_LIMIT))
      );

      if (request !== pageRequest.current) return;
      const tokenUpdates: Partial<PageTokens> = {};
      for (const result of results) {
        tokenUpdates[result.type] = result.nextPageToken;
      }
      const incoming = results.flatMap((result) => result.events);
      const merged = mergeEvents(reset ? [] : eventsRef.current, incoming);
      const nextTokens = reset
        ? { ...EMPTY_PAGE_TOKENS, ...tokenUpdates }
        : { ...nextPageTokensRef.current, ...tokenUpdates };
      nextPageTokensRef.current = nextTokens;
      setNextPageTokens(nextTokens);
      setEvents(merged);
      eventsRef.current = merged;
    } catch (err) {
      if (request === pageRequest.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request === pageRequest.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    if (view === "browse" && !browseRequested.current) {
      browseRequested.current = true;
      void loadPages(PAGE_TYPES, true);
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
    if (loading || loadingMore) return;
    setBrowseList([]);
    await loadPages(PAGE_TYPES, true);
  };

  const handleLoadMore = useCallback((types: EventPageType[]) => {
    if (loadingMoreRef.current) return;
    const loadable = types.filter((type) => nextPageTokensRef.current[type]);
    if (loadable.length === 0) return;
    loadingMoreRef.current = true;
    loadPages(loadable, false).finally(() => {
      loadingMoreRef.current = false;
    });
  }, [loadPages]);

  const handleSelectEvent = (event: DashcamEvent, filteredList?: DashcamEvent[]) => {
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

  const handleTimeUpdate = useCallback((time: number, playing: boolean) => {
    setPlayerDisplayTime((prev) => Math.abs(prev - time) < 0.05 ? prev : time);
    setPlayerIsPlaying((prev) => prev === playing ? prev : playing);
  }, []);

  const hasMorePages = useMemo(() => ({
    SavedClips: Boolean(nextPageTokens.SavedClips),
    SentryClips: Boolean(nextPageTokens.SentryClips),
    RecentClips: Boolean(nextPageTokens.RecentClips),
  }), [nextPageTokens]);

  return (
    <ErrorBoundary>
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div hidden={view !== "browse"} style={{ height: "100%" }}>
          <EventBrowser
            events={events}
            loading={loading}
            loadingMore={loadingMore}
            error={error}
            onSelectEvent={handleSelectEvent}
            onRefresh={handleRefresh}
            onLoadMore={handleLoadMore}
            hasMore={hasMorePages}
          />
        </div>
        {view === "player" && (selectedEvent ? (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
            <Player
              event={selectedEvent}
              onBack={handleBack}
              onRefresh={() => { void loadRoute(selectedEvent, true); }}
              onNavigate={handleNavigate}
              hasPrev={selectedIdx > 0}
              hasNext={selectedIdx < navList.length - 1}
              onTimeUpdate={selectedEvent.type === "RecentClips" ? handleTimeUpdate : undefined}
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
