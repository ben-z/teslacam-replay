import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { videoUrl } from "../api";
import type { DashcamEvent, CameraAngle } from "../types";
import { ALL_CAMERAS, CAMERA_LABELS, formatReason } from "../types";
import "./Player.css";

interface Props {
  event: DashcamEvent;
  onBack: () => void;
  onNavigate?: (direction: -1 | 1) => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}

type Layout = "grid" | "focus";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const SYNC_THRESHOLD = 0.15; // seconds - max drift before re-syncing
const SYNC_INTERVAL = 200; // ms - how often to check sync
const SEEK_STEP = 5; // seconds for arrow key seeking
const SPEED_OPTIONS = [0.5, 1, 1.5, 2];

// Grid positions for 3x2 layout
const GRID_POS = [
  [1, 1],
  [2, 1],
  [3, 1],
  [1, 2],
  [2, 2],
  [3, 2],
];

export function Player({ event, onBack, onNavigate, hasPrev, hasNext }: Props) {
  const [layout, setLayout] = useState<Layout>("focus");
  const [focusCamera, setFocusCamera] = useState<CameraAngle>("front");
  const [isPlaying, setIsPlaying] = useState(false);
  const [displayTime, setDisplayTime] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [segmentIdx, setSegmentIdx] = useState(0);

  const [videoErrors, setVideoErrors] = useState<Set<CameraAngle>>(new Set());
  const [segmentLoading, setSegmentLoading] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Refs for mutable state (avoid stale closures)
  const videoElsRef = useRef<Map<CameraAngle, HTMLVideoElement>>(new Map());
  const isPlayingRef = useRef(false);
  const segmentIdxRef = useRef(0);
  const playbackRateRef = useRef(1);
  const displayTimeRef = useRef(0);
  const syncIntervalRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const segmentOffsetsRef = useRef<number[]>([0]);

  // Keep refs in sync with state
  playbackRateRef.current = playbackRate;
  displayTimeRef.current = displayTime;

  // Cumulative start offsets for each segment, plus total duration
  const segmentOffsets = useMemo(() => {
    const offsets = [0];
    for (const clip of event.clips) {
      offsets.push(offsets[offsets.length - 1] + clip.durationSec);
    }
    return offsets;
  }, [event.clips]);

  segmentOffsetsRef.current = segmentOffsets;

  const totalDuration = segmentOffsets[segmentOffsets.length - 1];
  const segment = event.clips[segmentIdx];

  // Collect all cameras that appear anywhere in this event (stable across segments)
  const allEventCameras = useMemo(() => {
    const cams = new Set<CameraAngle>();
    for (const clip of event.clips) {
      for (const c of clip.cameras) cams.add(c as CameraAngle);
    }
    // Return in canonical order
    return ALL_CAMERAS.filter((c) => cams.has(c));
  }, [event.clips]);

  // Cameras available in the current segment (memoized to prevent callback churn)
  const activeCameras = useMemo(
    () => segment
      ? allEventCameras.filter((c) => segment.cameras.includes(c))
      : [],
    [allEventCameras, segment]
  );

  // Guard: if focusCamera is not in active set, fall back to front or first available
  let effectiveFocusCamera = focusCamera;
  if (!activeCameras.includes(focusCamera)) {
    if (activeCameras.includes("front")) {
      effectiveFocusCamera = "front";
    } else {
      effectiveFocusCamera = activeCameras[0] ?? focusCamera;
    }
  }

  // Primary camera for sync reference
  const getPrimaryCamera = useCallback(
    (): CameraAngle =>
      activeCameras.includes("front") ? "front" : activeCameras[0] ?? "front",
    [activeCameras]
  );

  const setRef = useCallback(
    (camera: CameraAngle, el: HTMLVideoElement | null) => {
      if (el) videoElsRef.current.set(camera, el);
      else videoElsRef.current.delete(camera);
    },
    []
  );

  // Sync secondary videos to primary (skip sourceless elements)
  const syncAll = useCallback(() => {
    const pCam = getPrimaryCamera();
    const p = videoElsRef.current.get(pCam);
    if (!p || !p.currentSrc) return;
    videoElsRef.current.forEach((v) => {
      if (v === p || !v.currentSrc) return;
      if (Math.abs(v.currentTime - p.currentTime) > SYNC_THRESHOLD) {
        v.currentTime = p.currentTime;
      }
    });
  }, [getPrimaryCamera]);

  // Periodic time + sync update + segment-end detection
  const advanceSegmentRef = useRef<() => void>(() => {});
  useEffect(() => {
    syncIntervalRef.current = setInterval(() => {
      const pCam = getPrimaryCamera();
      const p = videoElsRef.current.get(pCam);
      if (p && isFinite(p.currentTime)) {
        const t = (segmentOffsetsRef.current[segmentIdxRef.current] || 0) + p.currentTime;
        setDisplayTime(t);
        displayTimeRef.current = t;
      }
      if (isPlayingRef.current) {
        syncAll();
        // Auto-advance if primary video ended
        if (p?.ended) advanceSegmentRef.current();
      }
    }, SYNC_INTERVAL);
    return () => clearInterval(syncIntervalRef.current);
  }, [syncAll, getPrimaryCamera]);

  const handleVideoError = useCallback((cam: CameraAngle) => {
    setVideoErrors((prev) => new Set(prev).add(cam));
  }, []);

  // Load a segment into all video elements
  const loadSegment = useCallback(
    (idx: number, seekTime = 0) => {
      const seg = event.clips[idx];
      if (!seg) return;

      setVideoErrors(new Set());
      setSegmentLoading(true);
      clearTimeout(loadTimeoutRef.current);

      videoElsRef.current.forEach((v, cam) => {
        if (seg.cameras.includes(cam)) {
          v.src = videoUrl(event.type, event.id, seg.timestamp, cam);
          v.load();
        } else {
          // Camera not in this segment - clear it
          v.pause();
          v.removeAttribute("src");
          v.load();
        }
      });

      // Resume on primary ready (guard against race: check readyState after attaching)
      const pCam = seg.cameras.includes("front")
        ? "front"
        : (seg.cameras[0] as CameraAngle);
      const p = videoElsRef.current.get(pCam);
      if (p) {
        const segCameras = seg.cameras;
        const onReady = () => {
          clearTimeout(loadTimeoutRef.current);
          setSegmentLoading(false);
          videoElsRef.current.forEach((v, cam) => {
            if (!segCameras.includes(cam)) return;
            v.currentTime = seekTime;
            v.playbackRate = playbackRateRef.current;
            if (isPlayingRef.current) v.play().catch(() => {});
          });
        };
        p.addEventListener("canplay", onReady, { once: true });
        // If already buffered enough, fire immediately
        if (p.readyState >= 3) {
          p.removeEventListener("canplay", onReady);
          onReady();
        }
        // Safety timeout: clear loading state if canplay never fires
        loadTimeoutRef.current = setTimeout(() => setSegmentLoading(false), 10000);
      }
    },
    [event.clips, event.type, event.id]
  );

  // Advance to next segment
  const advanceSegment = useCallback(() => {
    const nextIdx = segmentIdxRef.current + 1;
    if (nextIdx >= event.clips.length) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      return;
    }
    segmentIdxRef.current = nextIdx;
    setSegmentIdx(nextIdx);
    loadSegment(nextIdx, 0);
  }, [event.clips.length, loadSegment]);
  advanceSegmentRef.current = advanceSegment;

  // Play/Pause
  const togglePlay = useCallback(() => {
    if (isPlayingRef.current) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      videoElsRef.current.forEach((v) => v.pause());
    } else {
      syncAll();
      isPlayingRef.current = true;
      setIsPlaying(true);
      videoElsRef.current.forEach((v) => {
        if (!v.currentSrc) return;
        v.playbackRate = playbackRateRef.current;
        v.play().catch(() => {});
      });
    }
  }, [syncAll]);

  // Seek to global time
  const seekTo = useCallback(
    (globalTime: number) => {
      const offsets = segmentOffsetsRef.current;
      const clamped = Math.max(0, Math.min(globalTime, totalDuration - 0.1));
      // Find which segment this global time falls in
      let newSegIdx = 0;
      for (let i = event.clips.length - 1; i >= 0; i--) {
        if (clamped >= offsets[i]) { newSegIdx = i; break; }
      }
      const localTime = clamped - offsets[newSegIdx];

      if (newSegIdx !== segmentIdxRef.current) {
        segmentIdxRef.current = newSegIdx;
        setSegmentIdx(newSegIdx);
        loadSegment(newSegIdx, localTime);
      } else {
        videoElsRef.current.forEach((v) => {
          if (!v.currentSrc) return;
          v.currentTime = localTime;
        });
      }
      setDisplayTime(clamped);
      displayTimeRef.current = clamped;
    },
    [event.clips.length, loadSegment, totalDuration]
  );

  const containerRef = useRef<HTMLDivElement>(null);

  // Fullscreen toggle
  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      containerRef.current.requestFullscreen().catch(() => {});
    }
  }, []);

  // Capture screenshot from focused video
  const captureFrame = useCallback(() => {
    const v = videoElsRef.current.get(effectiveFocusCamera);
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")!.drawImage(v, 0, 0);
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    // Use ref to avoid re-creating this callback every 200ms during playback
    a.download = `dashreplay-${event.id}-${CAMERA_LABELS[effectiveFocusCamera]}-${formatTime(displayTimeRef.current).replace(":", "m")}s.png`;
    a.click();
  }, [effectiveFocusCamera, event.id]);

  // Audio toggle (only front camera has audio)
  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      const frontEl = videoElsRef.current.get("front");
      if (frontEl) frontEl.muted = next;
      return next;
    });
  }, []);

  // Playback speed
  const changeRate = useCallback((rate: number) => {
    setPlaybackRate(rate);
    playbackRateRef.current = rate;
    videoElsRef.current.forEach((v) => {
      v.playbackRate = rate;
    });
  }, []);

  // Reset state and load first segment when event changes
  useEffect(() => {
    // Stop existing playback
    isPlayingRef.current = false;
    setIsPlaying(false);
    videoElsRef.current.forEach((v) => v.pause());

    segmentIdxRef.current = 0;
    setSegmentIdx(0);
    setDisplayTime(0);
    displayTimeRef.current = 0;
    setVideoErrors(new Set());

    // Load the first segment (ensures canplay + loading state are properly handled)
    loadSegment(0, 0);
  }, [event.id, loadSegment]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimeout(loadTimeoutRef.current);
      videoElsRef.current.forEach((v) => {
        v.pause();
        v.removeAttribute("src");
        v.load();
      });
      videoElsRef.current.clear();
    };
  }, []);

  // Keyboard shortcuts (refs prevent churn from displayTime updates)
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (e.shiftKey) {
            // Shift+Left: jump to previous segment
            seekTo(Math.max(0, (segmentOffsetsRef.current[segmentIdxRef.current] || 0) - 0.1));
          } else {
            seekTo(displayTimeRef.current - SEEK_STEP);
          }
          break;
        case "ArrowRight":
          e.preventDefault();
          if (e.shiftKey) {
            // Shift+Right: jump to next segment
            seekTo(segmentOffsetsRef.current[segmentIdxRef.current + 1] || 0);
          } else {
            seekTo(displayTimeRef.current + SEEK_STEP);
          }
          break;
        case "[":
          if (onNavigate && hasPrev) onNavigate(-1);
          break;
        case "]":
          if (onNavigate && hasNext) onNavigate(1);
          break;
        case "f":
          setLayout((l) => (l === "focus" ? "grid" : "focus"));
          break;
        case "Escape":
          if (showShortcuts) { setShowShortcuts(false); } else { onBack(); }
          break;
        case "?":
          setShowShortcuts((s) => !s);
          break;
        case "m":
          toggleMute();
          break;
        case "s":
          captureFrame();
          break;
        case "1": case "2": case "3": case "4": case "5": case "6": {
          const idx = parseInt(e.key) - 1;
          if (idx < allEventCameras.length) {
            setFocusCamera(allEventCameras[idx]);
            setLayout("focus");
          }
          break;
        }
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [togglePlay, seekTo, onBack, onNavigate, hasPrev, hasNext, toggleMute, captureFrame, allEventCameras, showShortcuts]);

  // Compute cell position based on layout
  const getCellStyle = (
    cam: CameraAngle,
    activeIdx: number,
    isActive: boolean
  ): React.CSSProperties => {
    if (!isActive) return { display: "none" };
    if (layout === "grid") {
      const [col, row] = GRID_POS[activeIdx] || [1, 1];
      return { gridColumn: col, gridRow: row };
    }
    if (cam === effectiveFocusCamera) {
      return { gridColumn: 1, gridRow: "1 / -1" };
    }
    return { gridColumn: 2 };
  };

  const getContainerStyle = (): React.CSSProperties => {
    if (layout === "grid") {
      return {
        gridTemplateColumns: "repeat(3, 1fr)",
        gridTemplateRows: "repeat(2, 1fr)",
      };
    }
    const sidebarCount = Math.max(activeCameras.length - 1, 1);
    return {
      gridTemplateRows: `repeat(${sidebarCount}, 1fr)`,
    };
  };

  const isSentry = event.type === "SentryClips";

  if (allEventCameras.length === 0) {
    return (
      <div className="player-container">
        <header className="player-header">
          <button onClick={onBack} className="player-back-btn" aria-label="Back to browse">
            &larr; Back
          </button>
          <span className="player-header-title">No clips available</span>
        </header>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-dim)",
          }}
        >
          This event has no video clips.
        </div>
      </div>
    );
  }

  return (
    <div className="player-container" ref={containerRef}>
      {/* Header */}
      <header className="player-header">
        <div className="player-nav-group">
          <button onClick={onBack} className="player-back-btn" aria-label="Back to browse">
            &larr; Back
          </button>
          {onNavigate && (
            <>
              <button
                onClick={() => onNavigate(-1)}
                disabled={!hasPrev}
                className="player-nav-btn"
                title="Previous event ([)"
                aria-label="Previous event"
              >
                &lsaquo;
              </button>
              <button
                onClick={() => onNavigate(1)}
                disabled={!hasNext}
                className="player-nav-btn"
                title="Next event (])"
                aria-label="Next event"
              >
                &rsaquo;
              </button>
            </>
          )}
        </div>
        <div className="player-header-info">
          <span
            className="player-badge"
            style={{
              background: isSentry
                ? "var(--sentry-color)"
                : "var(--saved-color)",
            }}
          >
            {isSentry ? "Sentry" : "Saved"}
          </span>
          <span className="player-header-title">
            {event.city || event.id}
            <span className="player-header-date">
              {" "}&middot;{" "}
              {new Date(event.timestamp).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          </span>
          {event.reason && (
            <span className="player-header-reason">
              {formatReason(event.reason)}
            </span>
          )}
          {event.lat != null && event.lon != null && (
            <a
              href={`https://maps.google.com/?q=${event.lat},${event.lon}`}
              target="_blank"
              rel="noopener noreferrer"
              className="player-header-gps"
              title={`${event.lat.toFixed(4)}, ${event.lon.toFixed(4)}`}
            >
              Map
            </a>
          )}
        </div>

        <button
          className="player-capture-btn"
          onClick={captureFrame}
          title="Save screenshot (S)"
          aria-label="Save screenshot"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="12" cy="13" r="4" />
            <path d="M5 3v2M19 3v2" />
          </svg>
        </button>
        <div className="player-layout-toggle" role="group" aria-label="Layout">
          {(["grid", "focus"] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLayout(l)}
              className={`player-layout-btn ${layout === l ? "active" : ""}`}
              aria-pressed={layout === l}
            >
              {l === "grid" ? "Grid" : "Focus"}
            </button>
          ))}
        </div>
        <button
          className="player-shortcuts-hint"
          onClick={() => setShowShortcuts((s) => !s)}
          aria-label="Keyboard shortcuts"
        >
          ?
        </button>
      </header>

      {showShortcuts && (
        <div className="player-shortcuts-overlay" onClick={() => setShowShortcuts(false)}>
          <div className="player-shortcuts-panel" onClick={(e) => e.stopPropagation()}>
            <div className="player-shortcuts-title">
              Keyboard Shortcuts
              <button className="player-shortcuts-close" onClick={() => setShowShortcuts(false)} aria-label="Close">&times;</button>
            </div>
            <div className="player-shortcuts-grid">
              {([
                ["Space", "Play / Pause"],
                ["\u2190 \u2192", "Seek \u00b15 seconds"],
                ["Shift+\u2190 \u2192", "Previous / Next segment"],
                ["[ ]", "Previous / Next event"],
                ["F", "Toggle grid / focus layout"],
                ["M", "Mute / Unmute"],
                ["S", "Save screenshot"],
                ["1\u20136", "Switch camera"],
                ["Esc", "Back to browse"],
              ] as const).map(([key, desc]) => (
                <div key={key} className="player-shortcut-row">
                  <kbd>{key}</kbd>
                  <span>{desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Video area: stable DOM — all cameras always rendered, inactive hidden */}
      <div className={`player-videos player-videos-${layout}`} style={getContainerStyle()}>
        {allEventCameras.map((cam) => {
          const isActive = activeCameras.includes(cam);
          const activeIdx = activeCameras.indexOf(cam);
          return (
            <div
              key={cam}
              className={`player-video-cell ${cam === effectiveFocusCamera && layout === "focus" ? "focused" : ""}`}
              style={getCellStyle(cam, activeIdx, isActive)}
              onClick={() => {
                if (layout === "grid") {
                  setFocusCamera(cam);
                  setLayout("focus");
                } else if (cam !== effectiveFocusCamera) {
                  setFocusCamera(cam);
                } else {
                  togglePlay();
                }
              }}
              onDoubleClick={
                layout === "focus" && cam === effectiveFocusCamera
                  ? toggleFullscreen
                  : undefined
              }
            >
              <video
                ref={(el) => setRef(cam, el)}
                muted={cam === "front" ? isMuted : true}
                playsInline
                preload="metadata"
                aria-label={`${CAMERA_LABELS[cam]} camera`}
                onError={(e) => {
                  // Only report error if video has media loaded (ignore errors from clearing src)
                  if ((e.target as HTMLVideoElement).currentSrc) handleVideoError(cam);
                }}
              />
              <span className="player-cam-label">{CAMERA_LABELS[cam]}</span>
              {videoErrors.has(cam) && (
                <span className="player-video-error">Failed to load</span>
              )}
            </div>
          );
        })}
        {activeCameras.length > 0 && activeCameras.every((c) => videoErrors.has(c)) && (
          <div style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.7)",
            color: "var(--text-muted)",
            fontSize: 14,
            zIndex: 10,
            pointerEvents: "none",
          }}>
            All cameras failed to load for this segment
          </div>
        )}
      </div>

      {/* Transport controls */}
      <div className="player-controls">
        <button
          onClick={togglePlay}
          className="player-play-btn"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
              <polygon points="6,4 20,12 6,20" />
            </svg>
          )}
        </button>

        <button
          onClick={toggleMute}
          className="player-mute-btn"
          aria-label={isMuted ? "Unmute" : "Mute"}
          title={isMuted ? "Unmute (M)" : "Mute (M)"}
        >
          {isMuted ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 8.3v1.5a3 3 0 010 4.4v1.5a4.5 4.5 0 002.5-3.7z"/>
              <path d="M2 2l20 20" stroke="currentColor" strokeWidth="2" fill="none"/>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 8.3v1.5a3 3 0 010 4.4v1.5a4.5 4.5 0 002.5-3.7zM14 3.2v1.5a8.5 8.5 0 010 14.6v1.5a10 10 0 000-17.6z"/>
            </svg>
          )}
        </button>

        <span className="player-time">
          {formatTime(displayTime)} / {formatTime(totalDuration)}
        </span>

        <div
          className="player-timeline"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            setHoverTime(pct * totalDuration);
          }}
          onMouseLeave={() => setHoverTime(null)}
        >
          <div
            className="player-timeline-progress"
            style={{ width: `${totalDuration > 0 ? (displayTime / totalDuration) * 100 : 0}%` }}
          />
          {/* Segment boundary markers */}
          {event.clips.length > 1 && event.clips.slice(1).map((_, i) => (
            <div
              key={i}
              className="player-timeline-marker"
              style={{ left: `${(segmentOffsets[i + 1] / totalDuration) * 100}%` }}
            />
          ))}
          {hoverTime != null && (
            <span
              className="player-timeline-tooltip"
              style={{ left: `${(hoverTime / totalDuration) * 100}%` }}
            >
              {formatTime(hoverTime)}
            </span>
          )}
          <input
            type="range"
            className="player-seek"
            min={0}
            max={totalDuration}
            step={0.5}
            value={displayTime}
            onChange={(e) => seekTo(Number(e.target.value))}
            aria-label="Seek"
          />
          {segmentLoading && (
            <span className="player-timeline-loading">Loading...</span>
          )}
        </div>

        {event.clips.length > 1 && (
          <div className="player-segment-group" role="group" aria-label="Segment navigation">
            <button
              className="player-segment-btn"
              disabled={segmentIdx === 0}
              onClick={() => seekTo(Math.max(0, (segmentOffsetsRef.current[segmentIdx] || 0) - 0.1))}
              title="Previous segment (Shift+Left)"
              aria-label="Previous segment"
            >
              &lsaquo;
            </button>
            <span className="player-segment" aria-label={`Segment ${segmentIdx + 1} of ${event.clips.length}`}>
              {segmentIdx + 1}/{event.clips.length}
            </span>
            <button
              className="player-segment-btn"
              disabled={segmentIdx >= event.clips.length - 1}
              onClick={() => seekTo(segmentOffsetsRef.current[segmentIdx + 1] || 0)}
              title="Next segment (Shift+Right)"
              aria-label="Next segment"
            >
              &rsaquo;
            </button>
          </div>
        )}

        <div className="player-speed-group" role="group" aria-label="Playback speed">
          {SPEED_OPTIONS.map((rate) => (
            <button
              key={rate}
              onClick={() => changeRate(rate)}
              className={`player-speed-btn ${playbackRate === rate ? "active" : ""}`}
              aria-pressed={playbackRate === rate}
            >
              {rate}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
