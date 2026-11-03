import { useEffect, useRef, useState } from "react";
import { recordingWallTimeMs } from "../playback";
import { formatPlaybackTime, RECORDING_NAVIGATION, recordingTimeOffset, recordingViewport } from "../recordingNavigation";
import "./RecordingNavigation.css";

interface Props {
  baseTimestamp: string;
  total: number;
  position: number;
  seekTarget: { time: number };
  offsets: number[];
  durations: number[];
  completed: boolean[];
  trigger: number | null;
  loading: boolean;
  estimated: boolean;
  footageEnd: number | null;
  onSeek: (seconds: number) => void;
}

const CLOCK = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "UTC",
});
const WINDOWS = [60, 5 * 60, 15 * 60, 60 * 60];

export function RecordingNavigation({ baseTimestamp, total, position, seekTarget, offsets, durations, completed, trigger, loading, estimated, footageEnd, onSeek }: Props) {
  const [windowSec, setWindowSec] = useState<number | null>(() => total > RECORDING_NAVIGATION.initialWindowSec ? RECORDING_NAVIGATION.initialWindowSec : null);
  const [center, setCenter] = useState(seekTarget.time);
  const [following, setFollowing] = useState(true);
  const [preview, setPreview] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpError, setJumpError] = useState<string | null>(null);
  const jumpInput = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);
  const viewport = recordingViewport(total, windowSec ?? total, center);
  const { start, end, duration } = viewport;
  const base = recordingWallTimeMs(baseTimestamp);
  const clock = (time: number) => CLOCK.format(base + time * 1000);
  const inputTime = (time: number) => new Date(base + time * 1000).toISOString().slice(0, 19);
  const percent = (time: number) => (time - start) / duration * 100;
  const displayedPosition = preview ?? position;

  useEffect(() => {
    if (following && !dragging.current && (position < start || position > end)) setCenter(position);
  }, [following, position, start, end]);

  useEffect(() => {
    setCenter(seekTarget.time);
    setFollowing(true);
  }, [seekTarget]);

  useEffect(() => {
    if (jumpOpen) jumpInput.current?.focus();
  }, [jumpOpen]);

  const seek = (time: number) => {
    setFollowing(true);
    setCenter(time);
    onSeek(time);
  };
  const pointerTime = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return start + Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * duration;
  };
  const gapPath = offsets.slice(0, -2).flatMap((offset, index) => {
    const gapStart = offset + durations[index];
    const gapEnd = offsets[index + 1];
    return completed[index] && gapEnd > gapStart && gapStart < end && gapEnd > start
      ? [`M${Math.max(0, percent(gapStart))},0H${Math.min(100, percent(gapEnd))}V1H${Math.max(0, percent(gapStart))}Z`] : [];
  }).join("");
  // Dense minute boundaries obscure the clock on long recordings. Only draw
  // them when the current window has room to distinguish individual files.
  const boundaries = offsets.slice(1, -1).filter((time) => time > start && time < end);
  const tickTimes = Array.from({ length: 5 }, (_, index) => start + duration * index / 4);
  const hoverTime = preview ?? hover;

  return (
    <div className="recording-navigation">
      <div className="recording-navigation-tools">
        <label>View <select aria-label="Timeline window" value={windowSec !== null && windowSec < total ? windowSec : "all"} onChange={(event) => {
          setWindowSec(event.target.value === "all" ? null : Number(event.target.value));
          setFollowing(true);
          setCenter(position);
        }}>
          <option value="all">Whole recording</option>
          {WINDOWS.filter((seconds) => seconds < total).map((seconds) => <option key={seconds} value={seconds}>{seconds < 3600 ? `${seconds / 60} min` : "1 hour"}</option>)}
        </select></label>
        <button type="button" disabled={start === 0} aria-label="Earlier timeline window" onClick={() => { setFollowing(false); setCenter(Math.max(duration / 2, start - duration / 2)); }}>‹</button>
        <button type="button" disabled={end >= total} aria-label="Later timeline window" onClick={() => { setFollowing(false); setCenter(Math.min(total - duration / 2, end + duration / 2)); }}>›</button>
        <button type="button" aria-pressed={following} onClick={() => { setFollowing(true); setCenter(position); }}>Follow playhead</button>
        <button type="button" aria-expanded={jumpOpen} onClick={() => { setJumpOpen(!jumpOpen); setJumpError(null); }}>Jump to time</button>
      </div>
      {jumpOpen && <form className="recording-jump" onSubmit={(event) => {
        event.preventDefault();
        const value = jumpInput.current!.value;
        try {
          seek(recordingTimeOffset(value.length === 16 ? `${value}:00` : value, baseTimestamp, total));
          setJumpError(null);
        } catch (error) {
          setJumpError(error instanceof Error ? error.message : String(error));
        }
      }}>
        <label>Recorded local time <input ref={jumpInput} type="datetime-local" step="1" required defaultValue={inputTime(position)} min={inputTime(0)} max={inputTime(total)} aria-label="Recorded local time" /></label>
        <button type="submit">Go</button>
        {jumpError && <span role="alert">{jumpError}</span>}
      </form>}
      <div className="recording-clock-labels" aria-hidden="true">
        {tickTimes.map((time, index) => <span key={index}>{clock(time)}</span>)}
      </div>
      <div className="player-timeline" role="slider" tabIndex={0}
        aria-label="Recording position" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(displayedPosition, total)}
        aria-valuetext={`${clock(displayedPosition)}; ${formatPlaybackTime(displayedPosition)} of ${estimated ? "approximately " : ""}${formatPlaybackTime(total)}${footageEnd !== null ? `; Selected footage ends at ${formatPlaybackTime(footageEnd)}` : ""}`}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          const target = event.key === "Home" ? 0 : event.key === "End" ? total
            : event.key === "ArrowLeft" || event.key === "ArrowDown" ? position - RECORDING_NAVIGATION.seekStepSec
            : event.key === "ArrowRight" || event.key === "ArrowUp" ? position + RECORDING_NAVIGATION.seekStepSec
            : event.key === "PageUp" ? position + duration : event.key === "PageDown" ? position - duration : null;
          if (target === null) return;
          event.preventDefault();
          event.stopPropagation();
          seek(Math.max(0, Math.min(total, target)));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          dragging.current = true;
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          setPreview(pointerTime(event));
        }}
        onPointerMove={(event) => { const time = pointerTime(event); if (dragging.current) setPreview(time); else if (event.pointerType !== "touch") setHover(time); }}
        onPointerUp={(event) => {
          if (!dragging.current) return;
          const time = pointerTime(event);
          dragging.current = false;
          setPreview(null);
          setHover(null);
          event.currentTarget.releasePointerCapture(event.pointerId);
          seek(time);
        }}
        onPointerCancel={() => { dragging.current = false; setPreview(null); setHover(null); }}
        onLostPointerCapture={() => { dragging.current = false; setPreview(null); }}
        onPointerLeave={() => setHover(null)}>
        {gapPath && <svg className="recording-gaps" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true"><path d={gapPath} /></svg>}
        <div className="player-timeline-progress" style={{ left: 0, width: `${Math.max(0, Math.min(100, percent(displayedPosition)))}%` }} />
        {boundaries.length <= RECORDING_NAVIGATION.maximumBoundaryMarkers && boundaries.map((time) => <div key={time} className="player-timeline-marker" style={{ left: `${percent(time)}%` }} />)}
        {trigger !== null && trigger >= start && trigger <= end && <div className="player-timeline-trigger" title="Event moment" style={{ left: `${percent(trigger)}%` }} />}
        {hoverTime !== null && <span className="player-timeline-tooltip" style={{ left: `${Math.max(0, Math.min(100, percent(hoverTime)))}%`, transform: `translateX(-${Math.max(0, Math.min(100, percent(hoverTime)))}%)` }}>{clock(hoverTime)} · {formatPlaybackTime(hoverTime)}</span>}
        {loading && <span className="player-timeline-loading">Loading…</span>}
      </div>
      {duration < total && <label className="recording-overview">Browse recording
        <input type="range" aria-label="Timeline window position" min={duration / 2} max={total - duration / 2} step="1" value={start + duration / 2}
          aria-valuetext={`${clock(start)} to ${clock(end)}`} onChange={(event) => { setFollowing(false); setCenter(Number(event.target.value)); }} />
      </label>}
    </div>
  );
}
