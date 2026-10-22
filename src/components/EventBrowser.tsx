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
  pendingTypes: EventPageType[];
  errorsByType: Partial<Record<EventPageType, string>>;
  hasMore: Record<EventPageType, boolean>;
  onSelectEvent: (event: DashcamEvent, filteredList: DashcamEvent[]) => void;
  onRefresh: () => void;
  onRetry: (type: EventPageType) => void;
  onLoadMore: (types: EventPageType[]) => void;
}

type FilterType = "all" | EventPageType;
type ViewType = "events" | "timeline";

const PAGE_SIZE = 48;
const SOURCE_TYPES: EventPageType[] = ["SavedClips", "SentryClips", "RecentClips"];
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
  pendingTypes,
  errorsByType,
  hasMore: hasMorePages,
  onSelectEvent,
  onRefresh,
  onRetry,
  onLoadMore,
}: Props) {
  const [view, setView] = useState<ViewType>("events");
  const [filter, setFilter] = useState<FilterType>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const pending = pendingTypes.length > 0;
  const failedTypes = SOURCE_TYPES.filter((type) => errorsByType[type] !== undefined);

  // Debounce search input
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      setSearch(searchInput);
      setVisibleCount(PAGE_SIZE);
      document.querySelector(".browse-content")?.scrollTo(0, 0);
    }, 200);
    return () => clearTimeout(debounceRef.current);
  }, [searchInput]);

  const loadedEvents = useMemo(() => events
    .filter((event) => filter === "all" || event.type === filter)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp)), [events, filter]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return loadedEvents;
    return loadedEvents.filter((event) =>
      event.city?.toLowerCase().includes(query) ||
      event.id.toLowerCase().includes(query) ||
      formatReason(event.reason).toLowerCase().includes(query) ||
      formatTimestamp(event.timestamp).toLowerCase().includes(query) ||
      formatDateGroup(event.timestamp).toLowerCase().includes(query)
    );
  }, [loadedEvents, search]);
  const oldestLoadedDate = loadedEvents.at(-1)?.timestamp.slice(0, 10);
  const newestLoadedDate = loadedEvents[0]?.timestamp.slice(0, 10);

  const setFilterAndReset = useCallback((f: FilterType) => {
    setView("events");
    setFilter(f);
    setVisibleCount(PAGE_SIZE);
    document.querySelector(".browse-content")?.scrollTo(0, 0);
  }, []);

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
  const hasMoreLoaded = view !== "timeline" && visibleCount < filtered.length;
  const pageTypesToLoad = useMemo<EventPageType[]>(() => {
    if (view === "timeline" || filter === "all") return SOURCE_TYPES;
    return [filter];
  }, [filter, view]);
  const remoteTypesToLoad = useMemo(
    () => pageTypesToLoad.filter((type) => hasMorePages[type] && errorsByType[type] === undefined),
    [hasMorePages, pageTypesToLoad, errorsByType]
  );
  const scopeIncomplete = pageTypesToLoad.some((type) => pendingTypes.includes(type) || errorsByType[type] !== undefined);
  const hasMoreRemote = remoteTypesToLoad.length > 0;
  const hasMore = hasMoreLoaded || hasMoreRemote;
  const loadedEventCount = events.length;
  const timelineAvailability = hasMoreRemote ? "Older recordings are available" : "No older recordings";
  const scopeSummary = search.trim()
    ? `${filtered.length} matches in ${loadedEvents.length} loaded recordings`
    : `${filtered.length} recordings loaded`;
  const handleCardSelect = useCallback(
    (event: DashcamEvent) => onSelectEvent(event, filtered),
    [onSelectEvent, filtered]
  );
  const handleLoadMore = useCallback(() => {
    if (hasMoreLoaded) {
      setVisibleCount((c) => c + PAGE_SIZE);
    } else if (hasMoreRemote && !pending) {
      onLoadMore(remoteTypesToLoad);
    }
  }, [hasMoreLoaded, hasMoreRemote, pending, onLoadMore, remoteTypesToLoad]);

  const timelineFooter = hasMoreRemote ? (
    <div className="browse-load-more browse-load-more--passive">
      <button
        type="button"
        className="browse-load-more-hint"
        disabled={pending}
        onClick={handleLoadMore}
      >
        Load older recordings
      </button>
    </div>
  ) : null;

  return (
    <div className="browse-container">
      <header className="browse-header">
        <div className="browse-header-top">
          <h1 className="browse-title">TeslaCam Replay</h1>
          <div className="browse-header-actions">
            <button
              onClick={onRefresh}
              disabled={pending}
              className="browse-refresh-btn"
              title="Refresh recordings"
            >
              Refresh
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
              Recordings ({loadedEventCount})
            </button>
            {(
              <button
                onClick={() => setView("timeline")}
                className={`browse-view-btn ${view === "timeline" ? "active" : ""}`}
                aria-pressed={view === "timeline"}
              >
                Timeline
              </button>
            )}
          </div>
          {view === "events" && (
            <>
              <div className="browse-filter-group" role="group" aria-label="Filter by type">
                {(
                  [
                    ["all", "All"],
                    ["SavedClips", "Saved"],
                    ["SentryClips", "Sentry"],
                    ["RecentClips", "Recent"],
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
                  placeholder="Search loaded recordings…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="browse-search"
                  aria-label="Search loaded recordings by city, date or reason"
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
        {pending && (
          <p className="browse-scope" role="status">
            Loading {pendingTypes.map((type) => BADGE_STYLES[type].label).join(", ")} recordings…
          </p>
        )}
        {failedTypes.map((type) => (
          <div className="browse-error" role="alert" key={type}>
            {BADGE_STYLES[type].label}: {errorsByType[type]}
            {events.some((event) => event.type === type) && (
              <> Previously loaded {BADGE_STYLES[type].label} recordings are still shown.</>
            )}
            {" "}<button onClick={() => onRetry(type)} disabled={pending}>Retry {BADGE_STYLES[type].label}</button>
          </div>
        ))}
        {view === "events" && (
          <p className="browse-scope" aria-live="polite">
            {scopeSummary}
            {search.trim() && oldestLoadedDate && (
              <> · Loaded dates: {oldestLoadedDate}{oldestLoadedDate !== newestLoadedDate && `–${newestLoadedDate}`}</>
            )}
            {hasMoreRemote && " · Older recordings are available"}
          </p>
        )}

        {view === "timeline" ? (
          <div className="recent-view">
            {!scopeIncomplete && (
              <div className="recent-scan-status" aria-live="polite">
                <span className="recent-scan-dot" />
                <span>{timelineAvailability}</span>
              </div>
            )}
            {!scopeIncomplete || events.some((event) => event.clips.length > 0) ? (
              <Timeline
                events={events}
                onSelectEvent={onSelectEvent}
                footer={timelineFooter}
              />
            ) : timelineFooter}
          </div>
        ) : filtered.length === 0 ? (
          <div className="browse-empty">
            {!scopeIncomplete && (search.trim() || filter !== "all" ? (
              <>
                <p>No loaded recordings match your filters</p>
                <button
                  onClick={() => { setFilter("all"); setSearchInput(""); }}
                  className="browse-clear-filters-btn"
                >
                  Clear filters
                </button>
              </>
            ) : (
              <p>No recordings in the loaded pages</p>
            ))}
            {hasMoreRemote && (
              <button className="browse-clear-filters-btn" onClick={handleLoadMore} disabled={pending}>
                Load older recordings
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
                          {dateCounts.get(curDate) || 0} recording{(dateCounts.get(curDate) || 0) !== 1 ? "s" : ""}
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
              <div className="browse-load-more">
                <button
                  type="button"
                  className="browse-load-more-hint"
                  disabled={pending && !hasMoreLoaded}
                  onClick={handleLoadMore}
                >
                  {hasMoreLoaded
                    ? `Show ${filtered.length - visibleCount} more recordings`
                    : "Load more recordings"}
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
        <div className={`browse-card-thumb${thumbState === "error" ? " browse-card-thumb--empty" : ""}`}>
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
                {event.clips.length} segment{event.clips.length !== 1 ? "s" : ""} &middot;{" "}
                {cameraCount} camera{cameraCount !== 1 ? "s" : ""}
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
