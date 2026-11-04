import { memo, useMemo, useState, useCallback, type ReactNode } from "react";
import type { DashcamEvent } from "../types";
import { compareRecordingOrder } from "../events";
import { formatUtcOffset, recordingOffsetMs, recordingWallTimeMs } from "../playback";
import "./Timeline.css";

interface Props {
  events: DashcamEvent[];
  fromDate?: string;
  onSelectEvent?: (event: DashcamEvent, sessionList: DashcamEvent[], startTime?: number) => void;
  footer?: ReactNode;
}

interface DayData {
  dateStr: string;
  utcOffsetMs: number;
  offsetLabel: string | null;
  weekday: string;
  dateLabel: string;
  sessions: SessionBlock[];
}

interface SessionBlock {
  startHour: number;
  endHour: number;
  durationMin: number;
  event: DashcamEvent;
  ranges: { startHour: number; endHour: number }[];
}

const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

const EVENT_TYPE_CLASS: Record<DashcamEvent["type"], "recent" | "sentry" | "saved"> = {
  RecentClips: "recent",
  SentryClips: "sentry",
  SavedClips: "saved",
};
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
const DATE_LABEL_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const DAY_MS = 24 * 60 * 60 * 1000;

function formatHour(h: number): string {
  const hr = Math.floor(h) % 24;
  if (hr === 0) return "12a";
  if (hr < 12) return `${hr}a`;
  if (hr === 12) return "12p";
  return `${hr - 12}p`;
}

function formatTimeDetailed(h: number): string {
  const totalMin = Math.floor(Math.round(h * 3_600_000) / 60_000);
  const hr = Math.floor(totalMin / 60) % 24;
  const min = totalMin % 60;
  const ampm = hr < 12 ? "AM" : "PM";
  const hr12 = hr % 12 || 12;
  return `${hr12}:${String(min).padStart(2, "0")} ${ampm}`;
}

function formatDurationShort(min: number): string {
  if (min < 1) return "<1m";
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const rm = min % 60;
    return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  }
  return `${min}m`;
}

/** Convert a calendar selection to the source recording clock, retaining gaps. */
export function timelineSelectionTime(event: DashcamEvent, dateStr: string, hour: number, utcOffsetMs: number): number {
  if (!Number.isFinite(hour) || hour < 0 || hour > 24) throw new Error(`Invalid Timeline selection hour: ${hour}`);
  if (!event.clips.length) throw new Error("Cannot select a recording without clips");
  const selectedTime = recordingWallTimeMs(`${dateStr}T00:00:00`) + hour * 3_600_000;
  return Math.max(0, (selectedTime - utcOffsetMs - event.clips[0].captureTimeMs) / 1000);
}

/** Draw calendar ranges while retaining full source recordings for selection. */
export function buildTimeline(events: DashcamEvent[], fromDate?: string): { days: DayData[]; sessionList: DashcamEvent[] } {
  if (fromDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    throw new Error(`Invalid Timeline start date: ${fromDate}`);
  }
  const fromDay = fromDate === undefined ? undefined : recordingWallTimeMs(`${fromDate}T00:00:00`);
  const dayMap = new Map<string, { day: number; utcOffsetMs: number; firstCaptureTimeMs: number; sessions: Map<string, SessionBlock> }>();
  for (const event of events) {
    const key = `${event.type}/${event.id}`;
    for (const clip of event.clips) {
      if (!Number.isFinite(clip.durationSec) || clip.durationSec <= 0) {
        throw new Error(`Invalid clip duration: ${event.type}/${event.id}/${clip.timestamp}`);
      }
      const utcOffsetMs = recordingOffsetMs(clip);
      const start = clip.captureTimeMs + utcOffsetMs;
      const end = start + clip.durationSec * 1000;
      const firstDay = Math.floor(start / DAY_MS) * DAY_MS;
      for (let day = fromDay === undefined ? firstDay : Math.max(firstDay, fromDay); day < end; day += DAY_MS) {
        const dayKey = `${day}/${utcOffsetMs}`;
        if (!dayMap.has(dayKey)) dayMap.set(dayKey, { day, utcOffsetMs, firstCaptureTimeMs: Infinity, sessions: new Map() });
        const entry = dayMap.get(dayKey)!;
        entry.firstCaptureTimeMs = Math.min(entry.firstCaptureTimeMs, Math.max(start, day) - utcOffsetMs);
        const sessions = entry.sessions;
        if (!sessions.has(key)) {
          sessions.set(key, { startHour: 24, endHour: 0, durationMin: 0, event, ranges: [] });
        }
        const session = sessions.get(key)!;
        session.ranges.push({
          startHour: (Math.max(start, day) - day) / 3_600_000,
          endHour: (Math.min(end, day + DAY_MS) - day) / 3_600_000,
        });
      }
    }
  }
  const dayOffsets = new Map<number, Set<number>>();
  for (const { day, utcOffsetMs } of dayMap.values()) {
    if (!dayOffsets.has(day)) dayOffsets.set(day, new Set());
    dayOffsets.get(day)!.add(utcOffsetMs);
  }
  const days: DayData[] = [...dayMap.values()]
    .sort((a, b) => b.day - a.day || a.firstCaptureTimeMs - b.firstCaptureTimeMs)
    .map(({ day, utcOffsetMs, sessions }) => ({
      utcOffsetMs,
      offsetLabel: dayOffsets.get(day)!.size > 1 ? formatUtcOffset(utcOffsetMs) : null,
      dateStr: new Date(day).toISOString().slice(0, 10),
      weekday: WEEKDAY_FORMATTER.format(day),
      dateLabel: DATE_LABEL_FORMATTER.format(day),
      sessions: [...sessions.values()].map((session) => {
        const merged: SessionBlock["ranges"] = [];
        for (const range of session.ranges.sort((a, b) => a.startHour - b.startHour)) {
          const last = merged.at(-1);
          if (last && range.startHour <= last.endHour) last.endHour = Math.max(last.endHour, range.endHour);
          else merged.push({ ...range });
        }
        return {
          ...session,
          ranges: merged,
          startHour: merged[0].startHour,
          endHour: merged.at(-1)!.endHour,
          durationMin: Math.round(merged.reduce((sum, range) => sum + range.endHour - range.startHour, 0) * 60),
        };
      }).sort((a, b) => {
        const aOrder = a.event.type === "RecentClips" ? 0 : 1;
        const bOrder = b.event.type === "RecentClips" ? 0 : 1;
        return aOrder - bOrder || a.startHour - b.startHour;
      }),
    }));

  const visibleEvents = new Map<string, DashcamEvent>();
  for (const day of days) {
    for (const { event } of day.sessions) visibleEvents.set(`${event.type}/${event.id}`, event);
  }
  return {
    days,
    sessionList: [...visibleEvents.values()].sort(compareRecordingOrder),
  };
}

export function Timeline({ events, fromDate, onSelectEvent, footer }: Props) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  const { days, sessionList } = useMemo(() => buildTimeline(events, fromDate), [events, fromDate]);
  const dayCount = new Set(days.map((day) => day.dateStr)).size;

  const handleSessionClick = useCallback((session: SessionBlock, day: DayData, hour: number) => {
    onSelectEvent?.(session.event, sessionList, timelineSelectionTime(session.event, day.dateStr, hour, day.utcOffsetMs));
  }, [onSelectEvent, sessionList]);

  const handleBarPointerMove = useCallback((e: React.PointerEvent, day: DayData) => {
    if (e.pointerType === "touch") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const hour = ((e.clientX - rect.left) / rect.width) * 24;
    if (hour < 0 || hour > 24) {
      setTooltip(null);
      return;
    }

    const hitTest = (s: SessionBlock) => s.ranges.some((range) => hour >= range.startHour && hour <= range.endHour);
    let session: SessionBlock | undefined;
    for (let index = day.sessions.length - 1; index >= 0; index--) {
      if (hitTest(day.sessions[index])) {
        session = day.sessions[index];
        break;
      }
    }
    const timeStr = formatTimeDetailed(hour);
    if (!session) {
      setTooltip({ x: e.clientX, y: e.clientY - 32, text: timeStr });
      return;
    }
    const typeClass = EVENT_TYPE_CLASS[session.event.type];
    const typeLabel = typeClass === "recent" ? "" : ` ${typeClass}`;
    const text = `${timeStr}${day.offsetLabel ? ` ${day.offsetLabel}` : ""} — ${formatDurationShort(session.durationMin)}${typeLabel} session`;
    setTooltip({ x: e.clientX, y: e.clientY - 32, text });
  }, []);

  const handleTooltipClear = useCallback(() => setTooltip(null), []);

  if (days.length === 0) {
    return (
      <div className="timeline">
        <div className="timeline-empty">{fromDate === undefined ? "No recorded video in the loaded pages" : "No loaded video in this date range"}</div>
        {footer}
      </div>
    );
  }

  return (
    <div className="timeline">
      <div className="timeline-overview">
        <div className="timeline-toolbar">
          <div className="timeline-summary">
            <strong>{sessionList.length}</strong> recording{sessionList.length !== 1 ? "s" : ""} shown
            {" "}· Video on <strong>{dayCount}</strong> day{dayCount !== 1 ? "s" : ""}
            <span className="timeline-coverage-note">Approximate recording coverage</span>
          </div>
          <div className="timeline-legend">
            <span className="timeline-legend-item"><span className="timeline-legend-dot timeline-legend-dot--recent" /> Recent</span>
            <span className="timeline-legend-item"><span className="timeline-legend-dot timeline-legend-dot--sentry" /> Sentry</span>
            <span className="timeline-legend-item"><span className="timeline-legend-dot timeline-legend-dot--saved" /> Saved</span>
          </div>
        </div>
        <div className="timeline-axis">
          <div className="timeline-axis-inner">
            {HOUR_TICKS.map((h) => (
              <span
                key={h}
                className="timeline-axis-label"
                style={{ left: `${(h / 24) * 100}%` }}
              >
                {formatHour(h)}
              </span>
            ))}
          </div>
        </div>
      </div>
      {days.map((day) => (
        <TimelineDayRow
          key={`${day.dateStr}/${day.utcOffsetMs}`}
          day={day}
          onSessionClick={handleSessionClick}
          onBarPointerMove={handleBarPointerMove}
          onTooltipClear={handleTooltipClear}
        />
      ))}
      {footer}

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

const TimelineDayRow = memo(function TimelineDayRow({
  day,
  onSessionClick,
  onBarPointerMove,
  onTooltipClear,
}: {
  day: DayData;
  onSessionClick: (session: SessionBlock, day: DayData, hour: number) => void;
  onBarPointerMove: (e: React.PointerEvent, day: DayData) => void;
  onTooltipClear: () => void;
}) {
  return (
    <div className="timeline-day">
      <div className="timeline-day-overview">
        <div className="timeline-day-label">
          <span className="timeline-day-label-weekday">{day.weekday}</span>
          <span className="timeline-day-label-date">{day.dateLabel}</span>
          {day.offsetLabel && <span className="timeline-day-label-date">{day.offsetLabel}</span>}
        </div>
        <div className="timeline-bar-container">
          <div
            className="timeline-bar-inner"
            onPointerMove={(e) => onBarPointerMove(e, day)}
            onPointerLeave={onTooltipClear}
          >
            <div className="timeline-track">
              {/* Exact pointer regions; the recording list provides accessible actions. */}
              <svg className="timeline-ranges" viewBox="0 0 24 1" preserveAspectRatio="none" aria-hidden="true">
                {day.sessions.map((session) => (
                  <path
                    key={`${session.event.type}/${session.event.id}`}
                    className={`timeline-segment timeline-segment--${EVENT_TYPE_CLASS[session.event.type]}`}
                    d={session.ranges.map(({ startHour, endHour }) =>
                      `M${startHour},0H${endHour}V1H${startHour}Z`).join("")}
                    onClick={(e) => {
                      const bar = e.currentTarget.closest(".timeline-bar-inner");
                      if (!bar) throw new Error("Timeline recording is missing its calendar track");
                      const rect = bar.getBoundingClientRect();
                      const hour = Math.max(0, Math.min(24, (e.clientX - rect.left) / rect.width * 24));
                      onSessionClick(session, day, hour);
                    }}
                  />
                ))}
              </svg>
            </div>
            {HOUR_TICKS.map((h) => (
              <div
                key={h}
                className="timeline-hour-mark"
                style={{ left: `${(h / 24) * 100}%` }}
              />
            ))}
          </div>
        </div>
      </div>
      <details className="timeline-recordings">
        <summary>{day.sessions.length} recording{day.sessions.length !== 1 ? "s" : ""} on {day.dateStr}{day.offsetLabel ? ` ${day.offsetLabel}` : ""}</summary>
        <div className="timeline-session-list">
          {[...day.sessions].sort((a, b) => b.startHour - a.startHour).map((session) => {
            const type = EVENT_TYPE_CLASS[session.event.type];
            return (
              <button
                type="button"
                key={`${session.event.type}/${session.event.id}`}
                className="timeline-session-button"
                aria-label={`Open ${type} recording at ${formatTimeDetailed(session.startHour)} on ${day.dateStr}${day.offsetLabel ? ` ${day.offsetLabel}` : ""}`}
                onClick={() => onSessionClick(session, day, session.startHour)}
              >
                <span className={`timeline-session-type timeline-segment--${type}`}>{type}</span>
                <span>{formatTimeDetailed(session.startHour)}</span>
                <span className="timeline-session-duration">about {formatDurationShort(session.durationMin)}</span>
              </button>
            );
          })}
        </div>
      </details>
    </div>
  );
});
