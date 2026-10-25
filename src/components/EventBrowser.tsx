import { Fragment, memo, useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  thumbnailUrl,
  EVENT_PAGE_TYPES,
  type EventPagePositions,
  type EventPageType,
} from "../api";
import type { DashcamEvent } from "../types";
import { formatReason } from "../types";
import { Timeline } from "./Timeline";
import { recordingWallTimeMs } from "../playback";
import { earlierTimelineDate, timelinePaging, TIMELINE_WINDOW_DAYS } from "../timelinePaging";
import "./EventBrowser.css";

interface Props {
  active: boolean;
  events: DashcamEvent[];
  pendingTypes: EventPageType[];
  errorsByType: Partial<Record<EventPageType, string>>;
  pagePositions: EventPagePositions;
  onSelectEvent: (event: DashcamEvent, filteredList: DashcamEvent[]) => void;
  onRefresh: () => void;
  onRetry: (type: EventPageType) => void;
  onLoadMore: (types: EventPageType[]) => void;
}

type FilterType = "all" | EventPageType;
type ViewType = "events" | "timeline";

const PAGE_SIZE = 48;
const SOURCE_TYPES = EVENT_PAGE_TYPES;
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
  active,
  events,
  pendingTypes,
  errorsByType,
  pagePositions,
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
  const [timelineFromDate, setTimelineFromDate] = useState<string>();
  const pending = pendingTypes.length > 0;
  const failedTypes = SOURCE_TYPES.filter((type) => errorsByType[type] !== undefined);

  // Debounce search input
  useEffect(() => {
    if (searchInput === search) return;
    const timeout = setTimeout(() => {
      setSearch(searchInput);
      setVisibleCount(PAGE_SIZE);
      document.querySelector(".browse-content")?.scrollTo(0, 0);
    }, 200);
    return () => clearTimeout(timeout);
  }, [searchInput, search]);

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
  const timelinePage = useMemo(() => timelinePaging(events, pagePositions, timelineFromDate),
    [events, pagePositions, timelineFromDate]);
  const pageTypesToLoad = useMemo<EventPageType[]>(() => {
    if (view === "timeline" || filter === "all") return SOURCE_TYPES;
    return [filter];
  }, [filter, view]);
  const knownRemoteTypes = useMemo(
    () => pageTypesToLoad.filter((type) => pagePositions[type]?.nextPageToken && errorsByType[type] === undefined),
    [pagePositions, pageTypesToLoad, errorsByType]
  );
  const remoteTypesToLoad = (view === "timeline" ? timelinePage.loadTypes : knownRemoteTypes)
    .filter((type) => !pendingTypes.includes(type) && errorsByType[type] === undefined);
  const scopeIncomplete = pageTypesToLoad.some((type) => pendingTypes.includes(type) || errorsByType[type] !== undefined);
  const hasMoreRemote = view === "timeline" ? timelinePage.hasOlder : knownRemoteTypes.length > 0;
  const canLoadRemote = remoteTypesToLoad.length > 0;
  const hasMore = hasMoreLoaded || hasMoreRemote;
  const loadedEventCount = events.length;
  const timelineFailedTypes = failedTypes.filter((type) =>
    !pagePositions[type] || timelinePage.loadTypes.includes(type) || timelinePage.manualTypes.includes(type));
  const timelinePending = [...timelinePage.loadTypes, ...timelinePage.manualTypes].some((type) => pendingTypes.includes(type));
  const initialPagesReady = SOURCE_TYPES.every((type) => pagePositions[type] || errorsByType[type] !== undefined);
  useEffect(() => {
    if (!active || view !== "timeline" || !initialPagesReady || !timelinePage.requestedFromDate
      || !timelinePage.rangeIncomplete) return;
    const failed = SOURCE_TYPES.some((type) => errorsByType[type] !== undefined
      && (!pagePositions[type] || timelinePage.loadTypes.includes(type) || timelinePage.manualTypes.includes(type)));
    if (failed) return;
    const next = timelinePage.loadTypes.filter((type) => !pendingTypes.includes(type));
    if (next.length > 0) onLoadMore(next);
  }, [active, view, initialPagesReady, timelinePage, pendingTypes, errorsByType, pagePositions, onLoadMore]);
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
    } else if (canLoadRemote) {
      onLoadMore(remoteTypesToLoad);
    }
  }, [hasMoreLoaded, canLoadRemote, onLoadMore, remoteTypesToLoad]);

  let timelineLoadLabel = "Load older recordings";
  let timelineActionPending = !canLoadRemote;
  if (timelinePage.requestedFromDate) {
    timelineLoadLabel = timelinePage.rangeIncomplete ? "Loading timeline…" : `Earlier ${TIMELINE_WINDOW_DAYS} days`;
    timelineActionPending = timelinePage.rangeIncomplete;
  } else if (timelinePending && !canLoadRemote) {
    timelineLoadLabel = "Loading older recordings…";
  }
  if (timelinePage.manualTypes.length > 0) {
    const labels = timelinePage.manualTypes.map((type) => BADGE_STYLES[type].label).join(", ");
    timelineActionPending = timelinePage.manualTypes.every((type) => pendingTypes.includes(type));
    timelineLoadLabel = timelineActionPending
      ? `Checking older ${labels} recordings…`
      : `Check older ${labels} recordings`;
  }
  if (timelineFailedTypes.length > 0) {
    timelineLoadLabel = `Retry ${timelineFailedTypes.map((type) => BADGE_STYLES[type].label).join(", ")}`;
    timelineActionPending = timelineFailedTypes.every((type) => pendingTypes.includes(type));
  }
  let timelineRangeStatus = "Archive loaded for this range.";
  if (timelineFailedTypes.length > 0) timelineRangeStatus = "Archive loading paused. Retry the failed source to continue.";
  else if (timelinePage.manualTypes.length > 0) timelineRangeStatus = "Check older recordings below to establish this range.";
  else if (timelinePage.rangeIncomplete) timelineRangeStatus = "Loading archive for this range…";

  const timelineFooter = hasMoreRemote ? (
    <div className="browse-load-more">
      <button
        type="button"
        className="browse-load-more-hint"
        aria-describedby={timelineFailedTypes.length > 0
          ? timelineFailedTypes.map((type) => `browse-error-${type}`).join(" ")
          : undefined}
        aria-disabled={timelineActionPending || undefined}
        onClick={() => {
          if (timelineActionPending) return;
          if (timelineFailedTypes.length > 0) {
            for (const type of timelineFailedTypes) {
              if (!pendingTypes.includes(type)) onRetry(type);
            }
          } else if (timelinePage.manualTypes.length > 0) {
            onLoadMore(timelinePage.manualTypes.filter((type) => !pendingTypes.includes(type)));
          } else if (timelinePage.requestedFromDate) {
            setTimelineFromDate(earlierTimelineDate(timelinePage.requestedFromDate, TIMELINE_WINDOW_DAYS));
          } else handleLoadMore();
        }}
      >
        {timelineLoadLabel}
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
              onClick={() => { setView("events"); setVisibleCount(PAGE_SIZE); document.querySelector(".browse-content")?.scrollTo(0, 0); }}
              className={`browse-view-btn ${view === "events" ? "active" : ""}`}
              aria-pressed={view === "events"}
            >
              Recordings ({loadedEventCount})
            </button>
            {(
              <button
                onClick={() => { setView("timeline"); document.querySelector(".browse-content")?.scrollTo(0, 0); }}
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
          <div className="browse-error" id={`browse-error-${type}`} role="alert" key={type}>
            {BADGE_STYLES[type].label}: {errorsByType[type]}
            {events.some((event) => event.type === type) && (
              <> Previously loaded {BADGE_STYLES[type].label} recordings are still shown.</>
            )}
            {" "}<button onClick={() => onRetry(type)} disabled={pendingTypes.includes(type)}>Retry {BADGE_STYLES[type].label}</button>
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
          <>
            <div className="recent-scan-status" aria-live="polite">
              <span>
                {timelinePage.requestedFromDate && timelinePage.newestDate
                  ? <>Timeline range: {timelinePage.requestedFromDate}–{timelinePage.newestDate}.
                    {" "}{timelineRangeStatus}
                    {timelinePage.rangeIncomplete && timelinePage.fromDate
                      && ` Showing loaded recordings from ${timelinePage.fromDate} onward.`}</>
                  : timelinePage.rangeIncomplete || scopeIncomplete
                    ? "The common time range is not available yet."
                    : "No older recordings."}
              </span>
            </div>
            {!scopeIncomplete || events.some((event) => event.clips.length > 0) ? (
              <Timeline
                events={events}
                fromDate={timelinePage.fromDate}
                onSelectEvent={onSelectEvent}
                footer={timelineFooter}
              />
            ) : timelineFooter}
          </>
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
              <button className="browse-clear-filters-btn" onClick={handleLoadMore} disabled={!canLoadRemote}>
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
                      active={active}
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
                  disabled={!hasMoreLoaded && !canLoadRemote}
                  onClick={handleLoadMore}
                >
                  {hasMoreLoaded
                    ? "Show more recordings"
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
  active,
}: {
  event: DashcamEvent;
  onSelect: (event: DashcamEvent) => void;
  active: boolean;
}) {
  const openButton = useRef<HTMLButtonElement>(null);
  const badge = BADGE_STYLES[event.type];
  const formattedTimestamp = useMemo(
    () => formatTimestamp(event.timestamp),
    [event.timestamp]
  );
  const cameraCount = useMemo(() => {
    if (event.cameraCount != null) return event.cameraCount;
    return new Set(event.clips.flatMap((c) => c.cameras)).size;
  }, [event]);
  const previewUrl = thumbnailUrl(event.type, event.id, event.thumbnailVersion);
  const previewKey = `${event.hasThumbnail}:${previewUrl}`;
  const [preview, setPreview] = useState<{
    key: string; status: "loading" | "loaded" | "error"; attempt: number;
  } | null>(null);
  const image = preview?.key === previewKey
    ? preview
    : { key: previewKey, status: "loading" as const, attempt: 0 };
  const thumbState = event.hasThumbnail ? image.status : "absent";
  const requestUrl = image.attempt === 0
    ? previewUrl
    : `${previewUrl}${previewUrl.includes("?") ? "&" : "?"}attempt=${image.attempt}`;

  const handleClick = useCallback(() => onSelect(event), [event, onSelect]);

  return (
    <article className="browse-card">
      <button ref={openButton} onClick={handleClick} className="browse-card-open" aria-label={`Open ${badge.label} recording from ${formattedTimestamp}${event.city ? ` in ${event.city}` : ""}`}>
        <div className="browse-card-thumb">
          {active && event.hasThumbnail && thumbState !== "error" ? (
            <>
              {thumbState === "loading" && <div className="browse-card-shimmer" />}
              <img
                key={`${previewKey}:${image.attempt}`}
                src={requestUrl}
                alt=""
                className={`browse-card-img ${thumbState === "loaded" ? "loaded" : ""}`}
                loading="lazy"
                decoding="async"
                onLoad={() => setPreview({ ...image, status: "loaded" })}
                onError={() => setPreview({ ...image, status: "error" })}
              />
            </>
          ) : (
            <div className="browse-card-placeholder">
              {event.clips.length > 0 && <svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z" /></svg>}
              {thumbState === "error" && <span>Preview couldn’t load</span>}
            </div>
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
      {active && thumbState === "error" && (
        <button
          type="button"
          className="browse-card-preview-retry"
          aria-label={`Retry ${badge.label} preview for ${formattedTimestamp}`}
          onClick={() => {
            openButton.current!.focus();
            setPreview({ ...image, status: "loading", attempt: image.attempt + 1 });
          }}
        >Retry</button>
      )}
      {event.lat != null && event.lon != null && (
        <a href={`https://maps.google.com/?q=${event.lat},${event.lon}`} target="_blank" rel="noopener noreferrer" className="browse-card-gps" aria-label={`Open location of ${formattedTimestamp} in Google Maps`}>Map</a>
      )}
    </article>
  );
});
