import { memo, useMemo, useState, useCallback, type ReactNode, type Ref } from "react";
import type { DashcamEvent } from "../types";
import { recordingWallTimeMs } from "../playback";
import "./Timeline.css";

interface Props {
  events: DashcamEvent[];
  onSelectEvent?: (event: DashcamEvent, sessionList: DashcamEvent[]) => void;
  footer?: ReactNode;
  scrollRef?: Ref<HTMLDivElement>;
}

interface DayData {
  dateStr: string;
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

export function Timeline({ events, onSelectEvent, footer, scrollRef }: Props) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  const sessionList = useMemo(
    () => [...events].sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    [events],
  );

  const days: DayData[] = useMemo(() => {
    const dayMap = new Map<number, Map<string, SessionBlock>>();
    for (const event of events) {
      const key = `${event.type}/${event.id}`;
      for (const clip of event.clips) {
        if (!Number.isFinite(clip.durationSec) || clip.durationSec <= 0) {
          throw new Error(`Invalid clip duration: ${event.type}/${event.id}/${clip.timestamp}`);
        }
        const start = recordingWallTimeMs(clip.timestamp);
        const end = start + clip.durationSec * 1000;
        for (let day = Math.floor(start / DAY_MS) * DAY_MS; day < end; day += DAY_MS) {
          if (!dayMap.has(day)) dayMap.set(day, new Map());
          const sessions = dayMap.get(day)!;
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
    return [...dayMap.entries()].sort(([a], [b]) => b - a).map(([day, sessions]) => ({
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
  }, [events]);

  const handleSessionClick = useCallback((session: SessionBlock) => {
    onSelectEvent?.(session.event, sessionList);
  }, [onSelectEvent, sessionList]);

  const handleBarMouseMove = useCallback((e: React.MouseEvent, day: DayData) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const hour = ((e.clientX - rect.left) / rect.width) * 24;
    if (hour < 0 || hour > 24) {
      setTooltip(null);
      return;
    }

    const hitTest = (s: SessionBlock) => s.ranges.some((range) => hour >= range.startHour && hour <= range.endHour);
    const session = day.sessions.find((s) => hitTest(s) && s.event.type !== "RecentClips")
      || day.sessions.find(hitTest);
    const timeStr = formatTimeDetailed(hour);
    if (!session) {
      setTooltip({ x: e.clientX, y: e.clientY - 32, text: timeStr });
      return;
    }
    const typeClass = EVENT_TYPE_CLASS[session.event.type];
    const typeLabel = typeClass === "recent" ? "" : ` ${typeClass}`;
    const text = `${timeStr} — ${formatDurationShort(session.durationMin)}${typeLabel} session`;
    setTooltip({ x: e.clientX, y: e.clientY - 32, text });
  }, []);

  const handleTooltipClear = useCallback(() => setTooltip(null), []);

  if (days.length === 0) {
    return (
      <div className="timeline">
        <div className="timeline-overview">
          <div className="timeline-scroll" ref={scrollRef}>
            <div className="timeline-empty">No recorded video in the loaded pages</div>
            {footer}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="timeline">
      <div className="timeline-overview">
        <div className="timeline-toolbar">
          <div className="timeline-summary">
            <strong>{events.length}</strong> loaded recording{events.length !== 1 ? "s" : ""}
            {" "}· Video on <strong>{days.length}</strong> day{days.length !== 1 ? "s" : ""}
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

        <div className="timeline-scroll" ref={scrollRef}>
          {days.map((day) => (
            <TimelineDayRow
              key={day.dateStr}
              day={day}
              onSessionClick={handleSessionClick}
              onBarMouseMove={handleBarMouseMove}
              onTooltipClear={handleTooltipClear}
            />
          ))}
          {footer}
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

const TimelineDayRow = memo(function TimelineDayRow({
  day,
  onSessionClick,
  onBarMouseMove,
  onTooltipClear,
}: {
  day: DayData;
  onSessionClick: (session: SessionBlock) => void;
  onBarMouseMove: (e: React.MouseEvent, day: DayData) => void;
  onTooltipClear: () => void;
}) {
  return (
    <div className="timeline-day">
      <div className="timeline-day-overview">
        <div className="timeline-day-label">
          <span className="timeline-day-label-weekday">{day.weekday}</span>
          <span className="timeline-day-label-date">{day.dateLabel}</span>
        </div>
        <div className="timeline-bar-container">
          <div
            className="timeline-bar-inner"
            onMouseMove={(e) => onBarMouseMove(e, day)}
            onMouseLeave={onTooltipClear}
          >
            <div className="timeline-track">
              {day.sessions.flatMap((session) => session.ranges.map((range, index) => {
                const left = (range.startHour / 24) * 100;
                const width = ((range.endHour - range.startHour) / 24) * 100;
                const typeClass = EVENT_TYPE_CLASS[session.event.type];
                const key = `${session.event.type}/${session.event.id}`;
                const label = `${typeClass} recording at ${formatTimeDetailed(range.startHour)} on ${day.dateStr}, about ${formatDurationShort(session.durationMin)}`;
                return (
                  <button
                    type="button"
                    key={`${key}/${index}`}
                    tabIndex={-1}
                    aria-label={`Open ${label}`}
                    className={`timeline-segment timeline-segment--${typeClass}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    onClick={() => onSessionClick(session)}
                    title={label}
                  />
                );
              }))}
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
        <summary>{day.sessions.length} recording{day.sessions.length !== 1 ? "s" : ""} on {day.dateStr}</summary>
        <div className="timeline-session-list">
          {[...day.sessions].sort((a, b) => b.startHour - a.startHour).map((session) => {
            const type = EVENT_TYPE_CLASS[session.event.type];
            return (
              <button
                type="button"
                key={`${session.event.type}/${session.event.id}`}
                className="timeline-session-button"
                aria-label={`Open ${type} recording at ${formatTimeDetailed(session.startHour)} on ${day.dateStr}`}
                onClick={() => onSessionClick(session)}
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
