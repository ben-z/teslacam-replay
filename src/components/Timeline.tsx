import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import type { DashcamEvent } from "../types";
import "./Timeline.css";

interface Props {
  events: DashcamEvent[]; // only RecentClips events
  onSelectEvent: (event: DashcamEvent, filteredList: DashcamEvent[]) => void;
}

// Zoom levels: hours visible in the bar. 24 = full day, 1 = one hour.
const ZOOM_LEVELS = [24, 12, 6, 3, 1];
const DEFAULT_ZOOM = 0; // index into ZOOM_LEVELS (24h)

interface DayData {
  dateStr: string; // "YYYY-MM-DD"
  weekday: string;
  dateLabel: string;
  sessions: SessionBlock[];
}

interface SessionBlock {
  startHour: number; // fractional hours from midnight (0-24)
  endHour: number;
  durationMin: number;
  event: DashcamEvent;
}

function parseTimestamp(ts: string): Date {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return new Date(ts);
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6])
  );
}

function toFractionalHour(d: Date): number {
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

function formatHour(h: number): string {
  const hr = Math.floor(h) % 24;
  if (hr === 0) return "12a";
  if (hr < 12) return `${hr}a`;
  if (hr === 12) return "12p";
  return `${hr - 12}p`;
}

function formatTimeDetailed(h: number): string {
  const totalMin = Math.round(h * 60);
  const hr = Math.floor(totalMin / 60) % 24;
  const min = totalMin % 60;
  const ampm = hr < 12 ? "AM" : "PM";
  const hr12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
  return `${hr12}:${String(min).padStart(2, "0")} ${ampm}`;
}

function formatDurationShort(min: number): string {
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const rm = min % 60;
    return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  }
  return `${min}m`;
}

export function Timeline({ events, onSelectEvent }: Props) {
  const [zoomIdx, setZoomIdx] = useState(DEFAULT_ZOOM);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const scrollRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const hoursVisible = ZOOM_LEVELS[zoomIdx];

  // Build day data: one block per session (event), not per clip
  const days: DayData[] = useMemo(() => {
    const dayMap = new Map<string, SessionBlock[]>();

    for (const event of events) {
      if (event.clips.length === 0) continue;
      const firstClip = event.clips[0];
      const lastClip = event.clips[event.clips.length - 1];
      const startDate = parseTimestamp(firstClip.timestamp);
      const dateStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`;
      const startHour = toFractionalHour(startDate);
      const endHour = startHour + event.totalDurationSec / 3600;
      const durationMin = Math.round(event.totalDurationSec / 60);

      if (!dayMap.has(dateStr)) dayMap.set(dateStr, []);
      dayMap.get(dateStr)!.push({
        startHour,
        endHour: Math.min(endHour, 24),
        durationMin,
        event,
      });
    }

    const sorted = Array.from(dayMap.entries()).sort(([a], [b]) => b.localeCompare(a));

    return sorted.map(([dateStr, sessions]) => {
      const d = new Date(dateStr + "T12:00:00");
      return {
        dateStr,
        weekday: d.toLocaleDateString("en-US", { weekday: "short" }),
        dateLabel: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        sessions: sessions.sort((a, b) => a.startHour - b.startHour),
      };
    });
  }, [events]);

  // When zoom changes, auto-scroll each bar to center on first session
  useEffect(() => {
    if (hoursVisible >= 24) return;
    for (const [dateStr, el] of scrollRefs.current) {
      const day = days.find((d) => d.dateStr === dateStr);
      if (!day || day.sessions.length === 0) continue;
      const firstStart = day.sessions[0].startHour;
      const pxPerHour = el.scrollWidth / 24;
      const scrollTo = firstStart * pxPerHour - el.clientWidth / 2;
      el.scrollTo({ left: Math.max(0, scrollTo), behavior: "smooth" });
    }
  }, [hoursVisible, days]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoomIdx((prev) => {
      if (e.deltaY < 0) return Math.min(prev + 1, ZOOM_LEVELS.length - 1);
      if (e.deltaY > 0) return Math.max(prev - 1, 0);
      return prev;
    });
  }, []);

  const handleSegmentClick = useCallback((session: SessionBlock) => {
    onSelectEvent(session.event, events);
  }, [onSelectEvent, events]);

  const handleBarMouseMove = useCallback((e: React.MouseEvent, day: DayData) => {
    const bar = e.currentTarget as HTMLElement;
    const scrollEl = bar.closest(".timeline-bar-scroll") as HTMLElement;
    if (!scrollEl) return;
    const rect = scrollEl.getBoundingClientRect();
    const x = e.clientX - rect.left + scrollEl.scrollLeft;
    const hour = (x / bar.clientWidth) * 24;
    if (hour < 0 || hour > 24) {
      setTooltip(null);
      return;
    }
    const session = day.sessions.find((s) => hour >= s.startHour && hour <= s.endHour);
    const timeStr = formatTimeDetailed(hour);
    const text = session
      ? `${timeStr} — ${formatDurationShort(session.durationMin)} session`
      : timeStr;
    setTooltip({ x: e.clientX, y: e.clientY - 32, text });
  }, []);

  const handleBarMouseLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  const hourStep = hoursVisible <= 3 ? 0.5 : hoursVisible <= 6 ? 1 : hoursVisible <= 12 ? 2 : 3;
  const barWidthPercent = (24 / hoursVisible) * 100;

  const totalSessions = events.length;
  const totalMinutes = Math.round(events.reduce((s, e) => s + e.totalDurationSec, 0) / 60);

  if (days.length === 0) {
    return (
      <div className="timeline">
        <div className="timeline-empty">No recent clips</div>
      </div>
    );
  }

  return (
    <div className="timeline" onWheel={handleWheel}>
      <div className="timeline-toolbar">
        <div className="timeline-summary">
          <strong>{totalSessions}</strong> session{totalSessions !== 1 ? "s" : ""} across{" "}
          <strong>{days.length}</strong> day{days.length !== 1 ? "s" : ""}{" "}
          &middot; {formatDurationShort(totalMinutes)} total
        </div>
        <div className="timeline-zoom-group">
          <button
            className="timeline-zoom-btn"
            onClick={() => setZoomIdx((i) => Math.max(i - 1, 0))}
            disabled={zoomIdx === 0}
            title="Zoom out"
          >
            &minus;
          </button>
          <span className="timeline-zoom-label">{hoursVisible}h</span>
          <button
            className="timeline-zoom-btn"
            onClick={() => setZoomIdx((i) => Math.min(i + 1, ZOOM_LEVELS.length - 1))}
            disabled={zoomIdx === ZOOM_LEVELS.length - 1}
            title="Zoom in"
          >
            +
          </button>
        </div>
      </div>

      <div className="timeline-scroll">
        {days.map((day) => (
          <div className="timeline-day" key={day.dateStr}>
            <div className="timeline-day-label">
              <span className="timeline-day-label-weekday">{day.weekday}</span>
              <span className="timeline-day-label-date">{day.dateLabel}</span>
            </div>
            <div className="timeline-bar-container">
              <div
                className="timeline-bar-scroll"
                ref={(el) => {
                  if (el) scrollRefs.current.set(day.dateStr, el);
                  else scrollRefs.current.delete(day.dateStr);
                }}
              >
                <div
                  className="timeline-bar-inner"
                  style={{ width: `${barWidthPercent}%` }}
                  onMouseMove={(e) => handleBarMouseMove(e, day)}
                  onMouseLeave={handleBarMouseLeave}
                >
                  <div className="timeline-track">
                    {day.sessions.map((session, i) => {
                      const left = (session.startHour / 24) * 100;
                      const width = Math.max(((session.endHour - session.startHour) / 24) * 100, 0.3);
                      return (
                        <div
                          key={i}
                          className="timeline-segment"
                          style={{ left: `${left}%`, width: `${width}%` }}
                          onClick={() => handleSegmentClick(session)}
                          title={`${formatTimeDetailed(session.startHour)} — ${formatDurationShort(session.durationMin)}`}
                        />
                      );
                    })}
                  </div>
                  {Array.from({ length: Math.ceil(24 / hourStep) + 1 }, (_, i) => {
                    const h = i * hourStep;
                    if (h > 24) return null;
                    return (
                      <div
                        key={h}
                        className="timeline-hour-mark"
                        style={{ left: `${(h / 24) * 100}%` }}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="timeline-axis">
        <div className="timeline-axis-inner">
          {Array.from({ length: Math.ceil(24 / hourStep) + 1 }, (_, i) => {
            const h = i * hourStep;
            if (h > 24) return null;
            const showLabel = hoursVisible >= 12 ? h % 3 === 0 : true;
            if (!showLabel) return null;
            return (
              <span
                key={h}
                className="timeline-axis-label"
                style={{ left: `${(h / 24) * barWidthPercent}%` }}
              >
                {h === 24 ? "12a" : formatHour(h)}
              </span>
            );
          })}
        </div>
      </div>

      {tooltip && (
        <div
          className="timeline-tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
