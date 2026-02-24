import { Fragment, useState, useMemo, useCallback, useRef, useEffect } from "react";
import { thumbnailUrl, fetchStatus, fetchCaches, clearCache, getApiBase, type ServerStatus, type CacheInfo } from "../api";
import type { DashcamEvent } from "../types";
import { formatReason } from "../types";
import { Timeline } from "./Timeline";
import "./EventBrowser.css";

interface Props {
  events: DashcamEvent[];
  loading: boolean;
  error: string | null;
  onSelectEvent: (event: DashcamEvent, filteredList: DashcamEvent[]) => void;
  onRefresh: () => void;
}

type FilterType = "all" | "SavedClips" | "SentryClips";
type ViewType = "events" | "recent";
type SortOrder = "newest" | "oldest";

const PAGE_SIZE = 48;

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return ts;
  }
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  }
  return `${m} min`;
}

function formatDateGroup(ts: string): string {
  try {
    return new Date(ts).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return ts;
  }
}

function dateKey(ts: string): string {
  try {
    return new Date(ts).toDateString();
  } catch {
    return ts;
  }
}

export function EventBrowser({
  events,
  loading,
  error,
  onSelectEvent,
  onRefresh,
}: Props) {
  const [view, setView] = useState<ViewType>("events");
  const [filter, setFilter] = useState<FilterType>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [status, setStatus] = useState<ServerStatus | null>(null);

  useEffect(() => {
    fetchStatus().then(setStatus).catch(() => {});
  }, [events]); // refresh status when events change

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
      return events.filter((e) => e.type === "RecentClips");
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
          e.reason?.toLowerCase().includes(q)
      );
    }
    if (sortOrder === "oldest") {
      result = [...result].reverse();
    }
    return result;
  }, [events, view, filter, search, sortOrder]);

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
  const hasMore = visibleCount < filtered.length;

  // Infinite scroll: load more when sentinel enters viewport
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount((c) => c + PAGE_SIZE);
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, filtered]);

  return (
    <div className="browse-container">
      <header className="browse-header">
        <div className="browse-header-top">
          <h1 className="browse-title">TeslaCam Replay</h1>
          <div className="browse-header-actions">
            <button
              onClick={onRefresh}
              disabled={loading}
              className="browse-refresh-btn"
              title="Rescan teslacam folder"
            >
              {loading ? "Scanning..." : "Refresh"}
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
            {counts.recent > 0 && (
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
              <button
                onClick={() => {
                  setSortOrder((s) => (s === "newest" ? "oldest" : "newest"));
                  setVisibleCount(PAGE_SIZE);
                }}
                className="browse-sort-btn"
                title={`Sort by ${sortOrder === "newest" ? "oldest" : "newest"} first`}
              >
                {sortOrder === "newest" ? "Newest" : "Oldest"} &darr;
              </button>
              <div className="browse-search-wrapper">
                <input
                  type="text"
                  placeholder="Search by city, date, reason..."
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="browse-search"
                  aria-label="Search events"
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
        {error && <div className="browse-error">{error}</div>}

        {loading && events.length === 0 ? (
          <div className="browse-loading">
            <div className="browse-spinner" />
            <p>Loading events...</p>
            <p className="browse-loading-hint">
              First load may take a few minutes if files are on a cloud drive
            </p>
          </div>
        ) : view === "recent" ? (
          <Timeline events={events} onSelectEvent={onSelectEvent} />
        ) : filtered.length === 0 ? (
          <div className="browse-empty">
            {search.trim() || filter !== "all" ? (
              <>
                <p>No events match your filters</p>
                <button
                  onClick={() => { setFilter("all"); setSearchInput(""); }}
                  className="browse-clear-filters-btn"
                >
                  Clear filters
                </button>
              </>
            ) : (
              <p>No events found</p>
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
                      onClick={() => onSelectEvent(event, filtered)}
                    />
                  </Fragment>
                );
              })}
            </div>
            {hasMore && (
              <div className="browse-load-more" ref={sentinelRef}>
                <span className="browse-load-more-hint">
                  {filtered.length - visibleCount} more
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {status?.connected && (
        <div className="browse-status-bar">
          <span>Server: {getApiBase()}</span>
          <span className="browse-status-sep">&middot;</span>
          <span>Storage: {status.storageBackend}</span>
          {status.storagePath && (
            <>
              <span className="browse-status-sep">&middot;</span>
              <span className="browse-status-path">{status.storagePath}</span>
            </>
          )}
          {status.eventCount != null && (
            <>
              <span className="browse-status-sep">&middot;</span>
              <span>{status.eventCount} events</span>
            </>
          )}
          <DebugPanelToggle />
        </div>
      )}
    </div>
  );
}

const BADGE_STYLES: Record<string, { label: string; color: string }> = {
  SentryClips: { label: "Sentry", color: "var(--sentry-color)" },
  RecentClips: { label: "Recent", color: "var(--recent-color)" },
  SavedClips: { label: "Saved", color: "var(--saved-color)" },
};
const DEFAULT_BADGE = { label: "Saved", color: "var(--saved-color)" };

function EventCard({
  event,
  onClick,
}: {
  event: DashcamEvent;
  onClick: () => void;
}) {
  const badge = BADGE_STYLES[event.type] ?? DEFAULT_BADGE;
  const [thumbState, setThumbState] = useState<"loading" | "loaded" | "error">(
    event.hasThumbnail ? "loading" : "error"
  );

  return (
    <button onClick={onClick} className="browse-card">
      <div className="browse-card-thumb">
        {event.hasThumbnail && thumbState !== "error" ? (
          <>
            {thumbState === "loading" && <div className="browse-card-shimmer" />}
            <img
              src={thumbnailUrl(event.type, event.id)}
              alt=""
              className={`browse-card-img ${thumbState === "loaded" ? "loaded" : ""}`}
              loading="lazy"
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
        <div className="browse-card-date">
          {formatTimestamp(event.timestamp)}
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
          {event.clips.length} segments &middot;{" "}
          {new Set(event.clips.flatMap((c) => c.cameras)).size} cameras
          {event.lat != null && event.lon != null && (
            <>
              {" "}&middot;{" "}
              <a
                href={`https://maps.google.com/?q=${event.lat},${event.lon}`}
                target="_blank"
                rel="noopener noreferrer"
                className="browse-card-gps"
                onClick={(e) => e.stopPropagation()}
              >
                GPS
              </a>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** i;
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function DebugPanelToggle() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="debug-toggle-btn"
        onClick={() => setOpen((v) => !v)}
        title="Debug: cache management"
        aria-label="Toggle debug panel"
      >
        {/* wrench icon */}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.7 3.3a4.5 4.5 0 0 0-5.6-.5L9 4.7l-.7 2.6-2.6.7-1.9-1.9a4.5 4.5 0 0 0 .5 5.6 4.5 4.5 0 0 0 5.2.7l3.4 3.4a1.5 1.5 0 0 0 2.1-2.1l-3.4-3.4a4.5 4.5 0 0 0-.9-5z"/>
        </svg>
      </button>
      {open && <DebugPanel onClose={() => setOpen(false)} />}
    </>
  );
}

function DebugPanel({ onClose }: { onClose: () => void }) {
  const [caches, setCaches] = useState<CacheInfo[] | null>(null);
  const [clearing, setClearing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchCaches().then(setCaches).catch((e) => setError(e.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleClear = useCallback(async (id: string) => {
    setClearing(id);
    try {
      await clearCache(id);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Clear failed");
    } finally {
      setClearing(null);
    }
  }, [load]);

  const handleClearAll = useCallback(async () => {
    if (!caches) return;
    setClearing("all");
    try {
      await Promise.all(caches.map(c => clearCache(c.id)));
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Clear failed");
    } finally {
      setClearing(null);
    }
  }, [caches, load]);

  return (
    <div className="debug-overlay" onClick={onClose}>
      <div className="debug-panel" onClick={(e) => e.stopPropagation()}>
        <div className="debug-panel-header">
          <span className="debug-panel-title">Cache Management</span>
          <button className="debug-panel-close" onClick={onClose}>&times;</button>
        </div>
        {error && <div className="debug-panel-error">{error}</div>}
        {!caches ? (
          <div className="debug-panel-loading">Loading...</div>
        ) : (
          <>
            <div className="debug-cache-list">
              {caches.map((c) => (
                <div key={c.id} className="debug-cache-row">
                  <div className="debug-cache-info">
                    <span className="debug-cache-label">{c.label}</span>
                    <span className="debug-cache-detail">
                      {c.sizeBytes != null ? formatBytes(c.sizeBytes) : `${c.entryCount} entries`}
                      {c.path && <span className="debug-cache-path">{c.path}</span>}
                    </span>
                  </div>
                  <button
                    className="debug-cache-clear-btn"
                    onClick={() => handleClear(c.id)}
                    disabled={clearing !== null}
                  >
                    {clearing === c.id ? "..." : "Clear"}
                  </button>
                </div>
              ))}
            </div>
            <button
              className="debug-clear-all-btn"
              onClick={handleClearAll}
              disabled={clearing !== null}
            >
              {clearing === "all" ? "Clearing..." : "Clear All"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
