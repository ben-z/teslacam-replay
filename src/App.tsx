import { useState, useEffect, useCallback, useMemo, useRef, Component } from "react";
import type { ReactNode } from "react";
import {
  fetchEvent,
  fetchEventPage,
  fetchStatus,
  getApiBase,
  type EventPageType,
  type ServerStatus,
} from "./api";
import { EventBrowser } from "./components/EventBrowser";
import { Player } from "./components/Player";
import { Timeline } from "./components/Timeline";
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

const BROWSE_CACHE_KEY = "teslacam-replay:browse-events";
const PAGE_LOAD_LIMIT = 24;
const PAGE_TYPES: EventPageType[] = ["SavedClips", "SentryClips", "RecentClips"];

type PageTokens = Record<EventPageType, string | null>;
type PageAvailability = Record<EventPageType, boolean>;

const EMPTY_PAGE_TOKENS: PageTokens = {
  SavedClips: null,
  SentryClips: null,
  RecentClips: null,
};
const EMPTY_PAGE_AVAILABILITY: PageAvailability = {
  SavedClips: false,
  SentryClips: false,
  RecentClips: false,
};

function cacheEvents(data: DashcamEvent[]): void {
  try {
    localStorage.setItem(BROWSE_CACHE_KEY, JSON.stringify({
      apiBase: getApiBase(),
      events: data,
    }));
  } catch {}
}

function loadCachedEvents(): DashcamEvent[] {
  try {
    const cached = localStorage.getItem(BROWSE_CACHE_KEY);
    if (!cached) return [];
    const parsed: unknown = JSON.parse(cached);
    if (
      parsed &&
      typeof parsed === "object" &&
      "apiBase" in parsed &&
      "events" in parsed &&
      parsed.apiBase === getApiBase() &&
      Array.isArray(parsed.events)
    ) {
      return parsed.events;
    }
    localStorage.removeItem(BROWSE_CACHE_KEY);
    return [];
  } catch {
    try {
      localStorage.removeItem(BROWSE_CACHE_KEY);
    } catch {}
    return [];
  }
}

function sortEvents(data: DashcamEvent[]): DashcamEvent[] {
  return [...data].sort((a, b) => b.id.localeCompare(a.id));
}

function mergeEvent(existing: DashcamEvent, incoming: DashcamEvent): DashcamEvent {
  const clipsByTimestamp = new Map(existing.clips.map((clip) => [clip.timestamp, clip]));
  for (const clip of incoming.clips) {
    const prev = clipsByTimestamp.get(clip.timestamp);
    if (!prev) {
      clipsByTimestamp.set(clip.timestamp, clip);
      continue;
    }
    clipsByTimestamp.set(clip.timestamp, {
      ...prev,
      ...clip,
      cameras: Array.from(new Set([...prev.cameras, ...clip.cameras])),
      durationSec: Math.max(prev.durationSec, clip.durationSec),
      subfolder: prev.subfolder ?? clip.subfolder,
    });
  }
  const clips = Array.from(clipsByTimestamp.values())
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const cameraCount = new Set(clips.flatMap((clip) => clip.cameras)).size;
  return {
    ...existing,
    ...incoming,
    hasThumbnail: existing.hasThumbnail || incoming.hasThumbnail,
    clips,
    totalDurationSec: clips.reduce((sum, clip) => sum + clip.durationSec, 0),
    cameraCount,
  };
}

function mergeEvents(existing: DashcamEvent[], incoming: DashcamEvent[]): DashcamEvent[] {
  const byKey = new Map<string, DashcamEvent>();
  for (const event of existing) byKey.set(`${event.type}/${event.id}`, event);
  for (const event of incoming) {
    const key = `${event.type}/${event.id}`;
    const prev = byKey.get(key);
    byKey.set(key, prev ? mergeEvent(prev, event) : event);
  }
  return sortEvents(Array.from(byKey.values()));
}

export function App() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [events, setEvents] = useState<DashcamEvent[]>(() => {
    return loadCachedEvents();
  });
  const [loading, setLoading] = useState(events.length === 0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextPageTokens, setNextPageTokens] = useState<PageTokens>(EMPTY_PAGE_TOKENS);
  const [hasMorePages, setHasMorePages] = useState<PageAvailability>(EMPTY_PAGE_AVAILABILITY);
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

  const restoreHashEvent = useCallback(async (data: DashcamEvent[]) => {
    const hashEvent = parseHash();
    if (!hashEvent) return;

    let found = data.find(
      (e) => e.type === hashEvent.type && e.id === hashEvent.id
    );
    if (!found) {
      found = await fetchEvent(hashEvent.type, hashEvent.id);
      const merged = mergeEvents(data, [found]);
      setEvents(merged);
      cacheEvents(merged);
      eventsRef.current = merged;
    }
    selectEvent(found);
  }, [selectEvent]);

  const loadPages = useCallback(async (
    types: EventPageType[] = PAGE_TYPES,
    reset = false
  ) => {
    setError(null);
    if (reset) setLoading(true);
    else setLoadingMore(true);
    try {
      const tokenSource = reset ? EMPTY_PAGE_TOKENS : nextPageTokensRef.current;
      const results = await Promise.all(
        types.map((type) => fetchEventPage(type, tokenSource[type], PAGE_LOAD_LIMIT))
      );

      const tokenUpdates: Partial<PageTokens> = {};
      const availabilityUpdates: Partial<PageAvailability> = {};
      for (const result of results) {
        tokenUpdates[result.type] = result.nextPageToken;
        availabilityUpdates[result.type] = Boolean(result.nextPageToken);
      }
      const incoming = results.flatMap((result) => result.events);
      const merged = mergeEvents(reset ? [] : eventsRef.current, incoming);
      const nextTokens = reset
        ? { ...EMPTY_PAGE_TOKENS, ...tokenUpdates }
        : { ...nextPageTokensRef.current, ...tokenUpdates };
      nextPageTokensRef.current = nextTokens;
      setNextPageTokens(nextTokens);
      setHasMorePages((prev) => reset
        ? { ...EMPTY_PAGE_AVAILABILITY, ...availabilityUpdates }
        : { ...prev, ...availabilityUpdates }
      );
      setEvents(merged);
      cacheEvents(merged);
      eventsRef.current = merged;
      await restoreHashEvent(merged);
      fetchStatus().then(setStatus).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load events");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [restoreHashEvent]);

  const checkStatus = useCallback(() => {
    fetchStatus().then((s) => {
      setStatus(s);
      loadPages(PAGE_TYPES, true);
    }).catch(() => setLoading(false));
  }, [loadPages]);

  // Check server status on mount.
  useEffect(() => { checkStatus(); }, [checkStatus]);

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
          setPlayerDisplayTime(0);
          setPlayerIsPlaying(false);
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
    setSelectedEvent(event);
    setView("player");
    setPlayerDisplayTime(0);
    setPlayerIsPlaying(false);
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
        setPlayerDisplayTime(0);
        setPlayerIsPlaying(false);
        // Replace hash (don't push, so back goes to browse not previous event)
        history.replaceState(null, "", `#/event/${next.type}/${next.id}`);
      }
    },
    [navList, selectedIdx]
  );

  const handleTimeUpdate = useCallback((time: number, playing: boolean) => {
    setPlayerDisplayTime((prev) => Math.abs(prev - time) < 0.05 ? prev : time);
    setPlayerIsPlaying((prev) => prev === playing ? prev : playing);
  }, []);

  return (
    <ErrorBoundary>
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        {view === "browse" ? (
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
        ) : selectedEvent ? (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
            <Player
              event={selectedEvent}
              onBack={handleBack}
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
        ) : null}
      </div>
    </ErrorBoundary>
  );
}
