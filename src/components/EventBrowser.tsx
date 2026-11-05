import { Fragment, memo, useState, useMemo, useCallback, useEffect, useRef } from "react";
import { thumbnailUrl } from "../api";
import { archiveDayKey, RECORDING_TYPES, type ArchiveDayKey, type RecordingType } from "../archive";
import { catalogKey, type ArchiveState } from "../recordingArchive";
import type { DashcamEvent } from "../types";
import { formatReason } from "../types";
import { Timeline } from "./Timeline";
import { formatUtcOffset, recordingOffsetMs, recordingWallTimeMs } from "../playback";
import { compareRecordingOrder } from "../events";
import { earlierTimelineDate, timelinePaging, TIMELINE_WINDOW_DAYS } from "../timelinePaging";
import "./EventBrowser.css";

interface Props {
  active: boolean;
  events: DashcamEvent[];
  archive: ArchiveState;
  onSelectEvent: (event: DashcamEvent, filteredList: DashcamEvent[], startTime?: number) => void;
  onRefresh: (days: ArchiveDayKey[]) => void;
  onLoadCatalog: (type: RecordingType) => void;
  onLoadDays: (days: ArchiveDayKey[], refresh: boolean) => void;
}

type FilterType = "all" | RecordingType;
type ViewType = "events" | "timeline";

const PAGE_SIZE = 48;
const SOURCE_TYPES = RECORDING_TYPES;
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
  archive,
  onSelectEvent,
  onRefresh,
  onLoadCatalog,
  onLoadDays,
}: Props) {
  const [view, setView] = useState<ViewType>("events");
  const [filter, setFilter] = useState<FilterType>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [timelineFromDate, setTimelineFromDate] = useState<string>();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const recordingsTabRef = useRef<HTMLButtonElement>(null);
  const timelineTabRef = useRef<HTMLButtonElement>(null);
  const retryFocusRef = useRef<HTMLButtonElement | null>(null);
  const pending = archive.pending.size > 0;
  const failedResources = SOURCE_TYPES.flatMap((type) => {
    const resources = [{ key: catalogKey(type), label: `${BADGE_STYLES[type].label} dates`, type, date: null as string | null }];
    for (const date of archive.catalogs[type]?.dates ?? []) {
      resources.push({ key: archiveDayKey({ type, date }), label: `${BADGE_STYLES[type].label} ${date}`, type, date });
    }
    return resources.filter((resource) => archive.errors[resource.key] !== undefined);
  });
  useEffect(() => {
    const retryButton = retryFocusRef.current;
    if (!retryButton || retryButton.isConnected) return;
    retryFocusRef.current = null;
    if (active && document.hasFocus() && document.activeElement === document.body) {
      (view === "events" ? recordingsTabRef : timelineTabRef).current!.focus();
    }
  }, [active, archive.errors, view]);

  const clearSearch = () => {
    setSearchInput("");
    setSearch("");
    setVisibleCount(PAGE_SIZE);
    searchInputRef.current!.focus();
    document.querySelector(".browse-content")?.scrollTo(0, 0);
  };

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
    .sort(compareRecordingOrder), [events, filter]);

  const clockOffsetsByDate = useMemo(() => {
    const dates = new Map<string, Set<number>>();
    for (const event of loadedEvents) {
      const date = dateKey(event.timestamp);
      if (!dates.has(date)) dates.set(date, new Set());
      for (const clip of event.clips) dates.get(date)!.add(recordingOffsetMs(clip));
    }
    return dates;
  }, [loadedEvents]);

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
  const timelinePage = useMemo(() => timelinePaging(events, archive.catalogs, archive.days, timelineFromDate),
    [events, archive.catalogs, archive.days, timelineFromDate]);
  const sources = filter === "all" ? SOURCE_TYPES : [filter];
  const nextDays = sources.flatMap((type) => {
    const date = archive.catalogs[type]?.dates.find((date) => {
      const key = archiveDayKey({ type, date });
      return !archive.days[key] && !archive.pending.has(key) && archive.errors[key] === undefined;
    });
    return date ? [{ type, date }] : [];
  });
  const hasMoreRemote = sources.some((type) => archive.catalogs[type]?.dates.some((date) => !archive.days[archiveDayKey({ type, date })]));
  const canLoadRemote = nextDays.length > 0;
  const hasMore = hasMoreLoaded || hasMoreRemote;
  const loadedEventCount = events.length;
  const listReady = archive.restored && sources.every((type) => {
    const catalog = archive.catalogs[type];
    return catalog !== undefined && (catalog.dates.length === 0
      || archive.days[archiveDayKey({ type, date: catalog.dates[0] })] !== undefined);
  });
  useEffect(() => {
    if (!active || !archive.restored) return;
    const missing = view === "timeline" ? timelinePage.loadDays : SOURCE_TYPES.flatMap((type) => {
      const date = archive.catalogs[type]?.dates[0];
      return date && !archive.days[archiveDayKey({ type, date })] ? [{ type, date }] : [];
    });
    const needed = missing.filter((day) => {
      const key = archiveDayKey(day);
      return !archive.pending.has(key) && archive.errors[key] === undefined;
    });
    if (needed.length > 0) onLoadDays(needed, false);
  }, [active, view, archive.restored, archive.catalogs, archive.days, archive.pending, archive.errors, timelinePage, onLoadDays]);
  const scopeSummary = search.trim()
    ? `${filtered.length} matches in ${loadedEvents.length} loaded recordings`
    : `${filtered.length} recordings loaded`;
  const handleCardSelect = useCallback(
    (event: DashcamEvent) => onSelectEvent(event, filtered),
    [onSelectEvent, filtered]
  );
  const handleLoadMore = () => {
    if (hasMoreLoaded) setVisibleCount((count) => count + PAGE_SIZE);
    else onLoadDays(nextDays, false);
  };
  const refreshDays = view === "timeline" ? timelinePage.requiredDays : Object.values(archive.days).filter((day) =>
    sources.includes(day.type) && (day.date === archive.catalogs[day.type]?.dates[0]
      || visible.some((event) => event.type === day.type && event.id.slice(0, 10) === day.date)));
  const missingFailed = timelinePage.loadDays.some((day) => archive.errors[archiveDayKey(day)] !== undefined)
    || SOURCE_TYPES.some((type) => !archive.catalogs[type] && archive.errors[catalogKey(type)] !== undefined);
  let timelineRangeStatus = "Archive days loaded for this range.";
  if (missingFailed) timelineRangeStatus = "Archive loading paused. Retry the failed request to continue.";
  else if (timelinePage.rangeIncomplete) timelineRangeStatus = `Showing loaded recordings; ${timelinePage.loadDays.length} archive days still need loading.`;
  const timelineFooter = timelinePage.hasOlder ? (
    <div className="browse-load-more">
      <button
        type="button"
        className="browse-load-more-hint"
        onClick={() => {
          if (!timelinePage.fromDate) return;
          setTimelineFromDate(earlierTimelineDate(timelinePage.fromDate, TIMELINE_WINDOW_DAYS));
        }}
      >Earlier {TIMELINE_WINDOW_DAYS} days</button>
    </div>
  ) : null;

  return (
    <div className="browse-container">
      <header className="browse-header">
        <div className="browse-header-top">
          <h1 className="browse-title">TeslaCam Replay</h1>
          <div className="browse-header-actions">
            <button
              onClick={() => onRefresh(refreshDays)}
              disabled={!archive.restored}
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
              ref={recordingsTabRef}
              onClick={() => { setView("events"); setVisibleCount(PAGE_SIZE); document.querySelector(".browse-content")?.scrollTo(0, 0); }}
              className={`browse-view-btn ${view === "events" ? "active" : ""}`}
              aria-pressed={view === "events"}
            >
              Recordings ({loadedEventCount})
            </button>
            {(
              <button
                ref={timelineTabRef}
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
                  ref={searchInputRef}
                  type="text"
                  placeholder="Search loaded recordings…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && searchInput) {
                      event.preventDefault();
                      clearSearch();
                    }
                  }}
                  className="browse-search"
                  aria-label="Search loaded recordings by city, date or reason"
                />
                {searchInput && (
                  <button
                    onClick={clearSearch}
                    className="browse-search-clear"
                    aria-label="Clear search"
                    title="Clear search (Esc)"
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
        {archive.cacheError && <p className="browse-error" role="alert">{archive.cacheError}</p>}
        {pending && (
          <p className="browse-scope" role="status">
            {events.length > 0 ? "Checking for recording updates…" : "Loading recordings…"}
          </p>
        )}
        {failedResources.map((resource) => (
          <div className="browse-error" role="alert" key={resource.key}>
            {resource.label}: {archive.errors[resource.key]}
            {(resource.date ? archive.days[resource.key] : archive.catalogs[resource.type]) && (
              <> Previously loaded recordings are still shown.</>
            )}
            {" "}<button
              onBlur={() => { retryFocusRef.current = null; }}
              onClick={(event) => {
                retryFocusRef.current = event.currentTarget;
                if (resource.date) onLoadDays([{ type: resource.type, date: resource.date }], true);
                else onLoadCatalog(resource.type);
              }}
            >Retry {resource.label}</button>
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
                {timelinePage.fromDate && timelinePage.newestDate
                  ? <>Timeline range: {timelinePage.fromDate}–{timelinePage.newestDate}.
                    {" "}{timelineRangeStatus}</>
                  : timelinePage.rangeIncomplete
                    ? "The common time range is not available yet."
                    : "No older recordings."}
              </span>
            </div>
            {!timelinePage.rangeIncomplete || events.some((event) => event.clips.length > 0) ? (
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
            {listReady && (search.trim() || filter !== "all" ? (
              <>
                <p>No loaded recordings match your filters</p>
                <button
                  onClick={() => { setFilter("all"); clearSearch(); }}
                  className="browse-clear-filters-btn"
                >
                  Clear filters
                </button>
              </>
            ) : (
              <p>No recordings in the loaded archive days</p>
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
                      showUtcOffset={clockOffsetsByDate.get(curDate)!.size > 1}
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
  showUtcOffset,
  onSelect,
  active,
}: {
  event: DashcamEvent;
  showUtcOffset: boolean;
  onSelect: (event: DashcamEvent) => void;
  active: boolean;
}) {
  const openButton = useRef<HTMLButtonElement>(null);
  const badge = BADGE_STYLES[event.type];
  const formattedTimestamp = useMemo(
    () => formatTimestamp(event.timestamp),
    [event.timestamp]
  );
  const clockLabel = useMemo(() => {
    const offsets = new Set(event.clips.map(recordingOffsetMs));
    if (offsets.size > 1) return "Clock changes";
    return showUtcOffset && event.clips.length > 0 ? formatUtcOffset(recordingOffsetMs(event.clips[0])) : null;
  }, [event.clips, showUtcOffset]);
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
      <button ref={openButton} onClick={handleClick} className="browse-card-open" aria-label={`Open ${badge.label} recording from ${formattedTimestamp}${clockLabel ? `; ${clockLabel}` : ""}${event.city ? ` in ${event.city}` : ""}`}>
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
            {clockLabel && <span className="browse-card-clock">{clockLabel}</span>}
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
