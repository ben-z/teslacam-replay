import { Fragment, memo, useState, useMemo, useCallback, useRef, useEffect } from "react";
import {
  thumbnailUrl,
  type EventPageType,
} from "../api";
import type { DashcamEvent } from "../types";
import { formatReason } from "../types";
import { Timeline } from "./Timeline";
import { recordingWallTimeMs } from "../playback";
import "./EventBrowser.css";

interface Props {
  events: DashcamEvent[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: Record<EventPageType, boolean>;
  onSelectEvent: (event: DashcamEvent, filteredList: DashcamEvent[]) => void;
  onRefresh: () => void;
  onLoadMore: (types: EventPageType[]) => void;
}

type FilterType = "all" | "SavedClips" | "SentryClips";
type ViewType = "events" | "recent";

const PAGE_SIZE = 48;
const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});
const DATE_GROUP_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});
const SCAN_FRONTIER_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function eventStartMs(event: DashcamEvent): number {
  return recordingWallTimeMs(event.clips[0]?.timestamp ?? event.timestamp);
}

function formatScanFrontier(ms: number | null): string {
  if (ms == null) return "not started";
  return SCAN_FRONTIER_FORMATTER.format(new Date(ms));
}

function formatTimestamp(ts: string): string {
  return TIMESTAMP_FORMATTER.format(new Date(recordingWallTimeMs(ts)));
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "No video";
  if (seconds < 60) return `~${Math.round(seconds)} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `~${hours}h ${remainder}m` : `~${hours}h`;
}

function formatDateGroup(ts: string): string {
  return DATE_GROUP_FORMATTER.format(new Date(recordingWallTimeMs(ts)));
}

function dateKey(ts: string): string {
  return ts.slice(0, 10);
}

export function EventBrowser({
  events,
  loading,
  loadingMore,
  error,
  hasMore: hasMorePages,
  onSelectEvent,
  onRefresh,
  onLoadMore,
}: Props) {
  const [view, setView] = useState<ViewType>("events");
  const [filter, setFilter] = useState<FilterType>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Debounce search input
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      setSearch(searchInput);
      setVisibleCount(PAGE_SIZE);
    }, 200);
    return () => clearTimeout(debounceRef.current);
  }, [searchInput]);

  const filtered = useMemo(() => {
    if (view === "recent") {
      return events.filter((e) => e.type === "RecentClips").sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }
    let result = events.filter((e) => e.type !== "RecentClips");
    if (filter !== "all") {
      result = result.filter((e) => e.type === filter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.city?.toLowerCase().includes(q) ||
          e.id.includes(q) ||
          formatReason(e.reason).toLowerCase().includes(q)
      );
    }
    return result.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [events, view, filter, search]);

  const setFilterAndReset = useCallback((f: FilterType) => {
    setView("events");
    setFilter(f);
    setVisibleCount(PAGE_SIZE);
    document.querySelector(".browse-content")?.scrollTo(0, 0);
  }, []);

  const counts = useMemo(() => {
    let saved = 0, sentry = 0, recent = 0;
    for (const e of events) {
      if (e.type === "SavedClips") saved++;
      else if (e.type === "SentryClips") sentry++;
      else if (e.type === "RecentClips") recent++;
    }
    return { total: saved + sentry, saved, sentry, recent };
  }, [events]);

  // Count events per date (from full filtered list for accurate counts)
  const dateCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of filtered) {
      const k = dateKey(e.timestamp);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }, [filtered]);

  const visible = filtered.slice(0, visibleCount);
  const hasMoreLoaded = view !== "recent" && visibleCount < filtered.length;
  const pageTypesToLoad = useMemo<EventPageType[]>(() => {
    if (view === "recent") return ["RecentClips"];
    if (filter === "all") return ["SavedClips", "SentryClips"];
    return [filter];
  }, [filter, view]);
  const remoteTypesToLoad = useMemo(
    () => pageTypesToLoad.filter((type) => hasMorePages[type]),
    [hasMorePages, pageTypesToLoad]
  );
  const hasMoreRemote = remoteTypesToLoad.length > 0;
  const hasMore = hasMoreLoaded || hasMoreRemote;
  const loadedEventCount = events.length;
  const recentScanLabel = !hasMorePages.RecentClips
    ? "Recent scan complete"
    : loadingMore
      ? "Scanning older recent clips"
      : "Ready to scan older clips";
  const recentScan = useMemo(() => {
    const recentEvents = events.filter((event) => event.type === "RecentClips");
    let oldestRecentMs: number | null = null;
    for (const event of recentEvents) {
      const ms = eventStartMs(event);
      if (ms > 0 && (oldestRecentMs == null || ms < oldestRecentMs)) {
        oldestRecentMs = ms;
      }
    }

    const timelineEvents = oldestRecentMs == null
      ? recentEvents
      : events.filter((event) =>
        event.type === "RecentClips" || eventStartMs(event) >= oldestRecentMs
      );

    return {
      timelineEvents,
      frontierLabel: formatScanFrontier(oldestRecentMs),
    };
  }, [events]);
  const handleCardSelect = useCallback(
    (event: DashcamEvent) => onSelectEvent(event, filtered),
    [onSelectEvent, filtered]
  );
  const handleLoadMore = useCallback(() => {
    if (hasMoreLoaded) {
      setVisibleCount((c) => c + PAGE_SIZE);
    } else if (hasMoreRemote && !loadingMore) {
      onLoadMore(remoteTypesToLoad);
    }
  }, [hasMoreLoaded, hasMoreRemote, loadingMore, onLoadMore, remoteTypesToLoad]);

  // Infinite scroll: load more when sentinel enters viewport
  const sentinelRef = useRef<HTMLDivElement>(null);
  const recentTimelineScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = view === "recent" ? recentTimelineScrollRef.current : null;
    if (!sentinel || !hasMore || search.trim() || error) return;
    if (view === "recent" && !root) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          handleLoadMore();
        }
      },
      { root, rootMargin: view === "recent" ? "120px" : "200px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, handleLoadMore, view, search, error]);

  return (
    <div className="browse-container">
      <header className="browse-header">
        <div className="browse-header-top">
          <h1 className="browse-title">TeslaCam Replay</h1>
          <div className="browse-header-actions">
            <button
              onClick={onRefresh}
              disabled={loading || loadingMore}
              className="browse-refresh-btn"
              title="Refresh recordings"
            >
              {loading ? "Loading..." : "Refresh"}
            </button>
          </div>
        </div>

        <div className="browse-filters">
          <div className="browse-view-toggle" role="group" aria-label="View">
            <button
              onClick={() => { setView("events"); setVisibleCount(PAGE_SIZE); }}
              className={`browse-view-btn ${view === "events" ? "active" : ""}`}
              aria-pressed={view === "events"}
            >
              Events ({counts.total})
            </button>
            {(
              <button
                onClick={() => setView("recent")}
                className={`browse-view-btn ${view === "recent" ? "active" : ""}`}
                aria-pressed={view === "recent"}
              >
                Recent ({counts.recent})
              </button>
            )}
          </div>
          {view === "events" && (
            <>
              <div className="browse-filter-group" role="group" aria-label="Filter by type">
                {(
                  [
                    ["all", "All"],
                    ["SavedClips", `Saved (${counts.saved})`],
                    ["SentryClips", `Sentry (${counts.sentry})`],
                  ] as [FilterType, string][]
                ).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => setFilterAndReset(value)}
                    className={`browse-filter-btn ${filter === value ? "active" : ""}`}
                    aria-pressed={filter === value}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="browse-search-wrapper">
                <input
                  type="text"
                  placeholder="Search loaded events…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="browse-search"
                  aria-label="Search loaded events by city, date or reason"
                />
                {searchInput && (
                  <button
                    onClick={() => setSearchInput("")}
                    className="browse-search-clear"
                    aria-label="Clear search"
                  >
                    &times;
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </header>

      <div className="browse-content">
        {error && <div className="browse-error" role="alert">{error} <button onClick={onRefresh} disabled={loading || loadingMore}>Retry</button></div>}
        {view === "events" && (
          <p className="browse-scope" aria-live="polite">
            {loading ? "Loading recordings…" : `${filtered.length} matching events loaded`}
            {hasMoreRemote && " · Older events are available"}
            {search.trim() && " · Search covers loaded events"}
          </p>
        )}

        {loading && events.length === 0 ? (
          <div className="browse-loading">
            <div className="browse-spinner" />
            <p>Loading events...</p>
            <p className="browse-loading-hint">
              Loading recordings
            </p>
          </div>
        ) : view === "recent" ? (
          <div className="recent-view">
            <div className="recent-scan-status" aria-live="polite">
              <span className={`recent-scan-dot ${loadingMore ? "active" : ""}`} />
              <span>{recentScanLabel}</span>
              <span className="recent-scan-frontier">
                Scanned back to {recentScan.frontierLabel}
              </span>
            </div>
            <Timeline
              events={recentScan.timelineEvents}
              onSelectEvent={onSelectEvent}
              scrollRef={recentTimelineScrollRef}
              footer={hasMorePages.RecentClips ? (
                <>
                  <div className="browse-load-more browse-load-more--passive">
                    <button
                      type="button"
                      className="browse-load-more-hint"
                      disabled={loadingMore}
                      onClick={handleLoadMore}
                    >
                      {loadingMore ? "Loading older clips..." : "Load older clips"}
                    </button>
                  </div>
                  <div className="browse-load-more-sentinel" ref={sentinelRef} aria-hidden="true" />
                </>
              ) : null}
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="browse-empty">
            {search.trim() || filter !== "all" ? (
              <>
                <p>No loaded events match your filters</p>
                <button
                  onClick={() => { setFilter("all"); setSearchInput(""); }}
                  className="browse-clear-filters-btn"
                >
                  Clear filters
                </button>
              </>
            ) : (
              <p>No events in the loaded pages</p>
            )}
            {hasMoreRemote && (
              <button className="browse-clear-filters-btn" onClick={handleLoadMore} disabled={loadingMore}>
                {loadingMore ? "Loading older events…" : "Load older events"}
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="browse-grid">
              {visible.map((event, i) => {
                const prevDate = i > 0 ? dateKey(visible[i - 1].timestamp) : null;
                const curDate = dateKey(event.timestamp);
                const showHeader = curDate !== prevDate;
                return (
                  <Fragment key={`${event.type}/${event.id}`}>
                    {showHeader && (
                      <div className="browse-date-header">
                        {formatDateGroup(event.timestamp)}
                        <span className="browse-date-count">
                          {dateCounts.get(curDate) || 0} event{(dateCounts.get(curDate) || 0) !== 1 ? "s" : ""}
                        </span>
                      </div>
                    )}
                    <EventCard
                      event={event}
                      onSelect={handleCardSelect}
                    />
                  </Fragment>
                );
              })}
            </div>
            {hasMore && (
              <div className="browse-load-more" ref={sentinelRef}>
                <button
                  type="button"
                  className="browse-load-more-hint"
                  disabled={loadingMore}
                  onClick={handleLoadMore}
                >
                  {hasMoreLoaded
                    ? `Show ${filtered.length - visibleCount} more events`
                    : loadingMore ? "Loading..." : "Load more events"}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <footer className="browse-status-bar">
        <span>{loadedEventCount} recordings loaded · Times shown as recorded</span>
      </footer>
    </div>
  );
}

const BADGE_STYLES: Record<string, { label: string; color: string }> = {
  SentryClips: { label: "Sentry", color: "var(--sentry-color)" },
  RecentClips: { label: "Recent", color: "var(--recent-color)" },
  SavedClips: { label: "Saved", color: "var(--saved-color)" },
};

const EventCard = memo(function EventCard({
  event,
  onSelect,
}: {
  event: DashcamEvent;
  onSelect: (event: DashcamEvent) => void;
}) {
  const badge = BADGE_STYLES[event.type];
  const formattedTimestamp = useMemo(
    () => formatTimestamp(event.timestamp),
    [event.timestamp]
  );
  const cameraCount = useMemo(() => {
    if (event.cameraCount != null) return event.cameraCount;
    return new Set(event.clips.flatMap((c) => c.cameras)).size;
  }, [event]);
  const [thumbState, setThumbState] = useState<"loading" | "loaded" | "error">(
    event.hasThumbnail ? "loading" : "error"
  );
  useEffect(() => {
    setThumbState(event.hasThumbnail ? "loading" : "error");
  }, [event.type, event.id, event.hasThumbnail, event.thumbnailVersion]);

  const handleClick = useCallback(() => onSelect(event), [event, onSelect]);

  return (
    <article className="browse-card">
      <button onClick={handleClick} className="browse-card-open" aria-label={`Open ${badge.label} recording from ${formattedTimestamp}${event.city ? ` in ${event.city}` : ""}`}>
        <div className="browse-card-thumb">
          {event.hasThumbnail && thumbState !== "error" ? (
            <>
              {thumbState === "loading" && <div className="browse-card-shimmer" />}
              <img
                src={thumbnailUrl(event.type, event.id, event.thumbnailVersion)}
                alt=""
                className={`browse-card-img ${thumbState === "loaded" ? "loaded" : ""}`}
                loading="lazy"
                decoding="async"
                onLoad={() => setThumbState("loaded")}
                onError={() => setThumbState("error")}
              />
            </>
          ) : (
            <div className="browse-card-placeholder">No preview</div>
          )}
          <span
            className="browse-card-badge"
            style={{ background: badge.color }}
          >
            {badge.label}
          </span>
          <span className="browse-card-duration">
            {formatDuration(event.totalDurationSec)}
          </span>
        </div>
        <div className="browse-card-info">
          <div className="browse-card-date" title={`Recorded local time: ${event.timestamp}`}>
            {formattedTimestamp}
          </div>
          {event.city && (
            <div className="browse-card-city">{event.city}</div>
          )}
          {event.reason && (
            <div className="browse-card-reason">
              {formatReason(event.reason)}
            </div>
          )}
          <div className="browse-card-meta">
            {event.clips.length === 0 ? (
              "No archived video"
            ) : (
              <>
                {event.clips.length} segments &middot;{" "}
                {cameraCount} cameras
              </>
            )}
          </div>
        </div>
      </button>
      {event.lat != null && event.lon != null && (
        <a href={`https://maps.google.com/?q=${event.lat},${event.lon}`} target="_blank" rel="noopener noreferrer" className="browse-card-gps" aria-label={`Open location of ${formattedTimestamp} in Google Maps`}>Map</a>
      )}
    </article>
  );
});
