import { useMemo, useState, useCallback, useRef } from "react";
import { Player } from "./Player";
import type { DashcamEvent } from "../types";
import "./Timeline.css";

interface Props {
  events: DashcamEvent[];
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
}

const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

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
  const hr12 = hr % 12 || 12;
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

export function Timeline({ events }: Props) {
  const [selectedEvent, setSelectedEvent] = useState<DashcamEvent | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const playerWrapperRef = useRef<HTMLDivElement>(null);

  const sessionList = useMemo(
    () => [...events].sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    [events],
  );

  const selectedIdx = useMemo(() => {
    if (!selectedEvent) return -1;
    return sessionList.findIndex(
      (e) => e.type === selectedEvent.type && e.id === selectedEvent.id
    );
  }, [sessionList, selectedEvent]);

  const days: DayData[] = useMemo(() => {
    const dayMap = new Map<string, SessionBlock[]>();

    for (const event of events) {
      if (event.clips.length === 0) continue;
      const startDate = parseTimestamp(event.clips[0].timestamp);
      const y = startDate.getFullYear();
      const mo = String(startDate.getMonth() + 1).padStart(2, "0");
      const da = String(startDate.getDate()).padStart(2, "0");
      const dateStr = `${y}-${mo}-${da}`;
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

  const handleSessionClick = useCallback((session: SessionBlock) => {
    setSelectedEvent(session.event);
    requestAnimationFrame(() => {
      playerWrapperRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  const handleBack = useCallback(() => {
    setSelectedEvent(null);
  }, []);

  const handleNavigate = useCallback(
    (direction: -1 | 1) => {
      const nextIdx = selectedIdx + direction;
      if (nextIdx >= 0 && nextIdx < sessionList.length) {
        setSelectedEvent(sessionList[nextIdx]);
      }
    },
    [sessionList, selectedIdx]
  );

  const handleBarMouseMove = useCallback((e: React.MouseEvent, day: DayData) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const hour = ((e.clientX - rect.left) / rect.width) * 24;
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

  const totalMinutes = Math.round(events.reduce((s, e) => s + e.totalDurationSec, 0) / 60);

  if (days.length === 0) {
    return (
      <div className="timeline">
        <div className="timeline-empty">No recent clips</div>
      </div>
    );
  }

  const isSelected = (event: DashcamEvent) =>
    selectedEvent?.type === event.type && selectedEvent?.id === event.id;

  return (
    <div className="timeline">
      {selectedEvent && (
        <div className="timeline-player-wrapper" ref={playerWrapperRef}>
          <Player
            event={selectedEvent}
            onBack={handleBack}
            onNavigate={handleNavigate}
            hasPrev={selectedIdx > 0}
            hasNext={selectedIdx < sessionList.length - 1}
          />
        </div>
      )}

      <div className="timeline-overview">
        <div className="timeline-toolbar">
          <div className="timeline-summary">
            <strong>{events.length}</strong> session{events.length !== 1 ? "s" : ""} across{" "}
            <strong>{days.length}</strong> day{days.length !== 1 ? "s" : ""}{" "}
            &middot; {formatDurationShort(totalMinutes)} total
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
                  className="timeline-bar-inner"
                  onMouseMove={(e) => handleBarMouseMove(e, day)}
                  onMouseLeave={() => setTooltip(null)}
                >
                  <div className="timeline-track">
                    {day.sessions.map((session, i) => {
                      const left = (session.startHour / 24) * 100;
                      const width = Math.max(((session.endHour - session.startHour) / 24) * 100, 0.3);
                      return (
                        <div
                          key={i}
                          className={`timeline-segment ${isSelected(session.event) ? "active" : ""}`}
                          style={{ left: `${left}%`, width: `${width}%` }}
                          onClick={() => handleSessionClick(session)}
                          title={`${formatTimeDetailed(session.startHour)} — ${formatDurationShort(session.durationMin)}`}
                        />
                      );
                    })}
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
          ))}
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
