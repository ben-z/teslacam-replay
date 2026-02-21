import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import Hls from "hls.js";
import { hlsManifestUrl, fetchTelemetry } from "../api";
import type { DashcamEvent, CameraAngle, TelemetryData, TelemetryFrame } from "../types";
import { ALL_CAMERAS, CAMERA_LABELS, formatReason } from "../types";
import { TelemetryOverlay } from "./TelemetryOverlay";
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

const BADGE_MAP = {
  SentryClips: { label: "Sentry", color: "var(--sentry-color)" },
  RecentClips: { label: "Recent", color: "var(--recent-color)" },
  SavedClips: { label: "Saved", color: "var(--saved-color)" },
} as const;

export function Player({ event, onBack, onNavigate, hasPrev, hasNext }: Props) {
  const [layout, setLayout] = useState<Layout>("grid");
  const [focusCamera, setFocusCamera] = useState<CameraAngle>("front");
  const [isPlaying, setIsPlaying] = useState(false);
  const [displayTime, setDisplayTime] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [segmentIdx, setSegmentIdx] = useState(0);

  const [videoErrors, setVideoErrors] = useState<Set<CameraAngle>>(new Set());
  const [bufferingCameras, setBufferingCameras] = useState<Set<CameraAngle>>(new Set());
  const [segmentLoading, setSegmentLoading] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [viewCenter, setViewCenter] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showTelemetry, setShowTelemetry] = useState(true);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [telemetryData, setTelemetryData] = useState<TelemetryData | null>(null);
  const [currentTelemFrame, setCurrentTelemFrame] = useState<TelemetryFrame | null>(null);

  // Refs for mutable state (avoid stale closures)
  const videoElsRef = useRef<Map<CameraAngle, HTMLVideoElement>>(new Map());
  const hlsInstancesRef = useRef<Map<CameraAngle, Hls>>(new Map());
  const isPlayingRef = useRef(false);
  const segmentIdxRef = useRef(0);
  const playbackRateRef = useRef(1);
  const displayTimeRef = useRef(0);
  const syncIntervalRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const segmentLoadingRef = useRef(false);
  const canplayCleanupRef = useRef<(() => void) | null>(null);
  const segmentOffsetsRef = useRef<number[]>([0]);
  const telemetryDataRef = useRef<TelemetryData | null>(null);
  const bufferingCamerasRef = useRef<Set<CameraAngle>>(new Set());
  const videoErrorsRef = useRef<Set<CameraAngle>>(new Set());

  // Keep refs in sync with state
  playbackRateRef.current = playbackRate;
  displayTimeRef.current = displayTime;
  telemetryDataRef.current = telemetryData;
  bufferingCamerasRef.current = bufferingCameras;
  videoErrorsRef.current = videoErrors;

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

  // Compute trigger time position on the seek bar (Sentry/Saved only)
  const triggerTimeGlobal = useMemo(() => {
    if (event.type === "RecentClips" || !event.timestamp) return null;
    const triggerEpoch = new Date(event.timestamp).getTime() / 1000;
    if (isNaN(triggerEpoch)) return null;

    // Parse clip timestamps once (shared between both passes)
    const clipEpochs = event.clips.map((clip) => {
      const iso = clip.timestamp.replace(/_/g, "T").replace(/-(\d{2})-(\d{2})$/, ":$1:$2");
      return new Date(iso).getTime() / 1000;
    });

    // Pass 1: find which segment the trigger falls within
    for (let i = 0; i < clipEpochs.length; i++) {
      if (isNaN(clipEpochs[i])) continue;
      const offsetInClip = triggerEpoch - clipEpochs[i];
      if (offsetInClip >= 0 && offsetInClip <= event.clips[i].durationSec) {
        return segmentOffsets[i] + offsetInClip;
      }
    }
    // Pass 2: fall back to matching clip start (common for Sentry folder timestamps)
    for (let i = 0; i < clipEpochs.length; i++) {
      if (isNaN(clipEpochs[i])) continue;
      if (Math.abs(triggerEpoch - clipEpochs[i]) < 2) {
        return segmentOffsets[i];
      }
    }
    return null;
  }, [event.type, event.timestamp, event.clips, segmentOffsets]);

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
  const activeCamerasRef = useRef<CameraAngle[]>([]);
  activeCamerasRef.current = activeCameras;

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

  // Find the best video element to use as sync reference.
  // Prefers the primary camera, falls back to any healthy active camera.
  const findRefVideo = useCallback((): HTMLVideoElement | undefined => {
    const errors = videoErrorsRef.current;
    const buffering = bufferingCamerasRef.current;
    const active = activeCamerasRef.current;
    const pCam = getPrimaryCamera();
    const primary = videoElsRef.current.get(pCam);
    if (primary?.currentSrc && !errors.has(pCam) && !buffering.has(pCam) && isFinite(primary.currentTime)) {
      return primary;
    }
    for (const cam of active) {
      if (errors.has(cam) || buffering.has(cam)) continue;
      const v = videoElsRef.current.get(cam);
      if (v?.currentSrc && isFinite(v.currentTime)) return v;
    }
    return undefined;
  }, [getPrimaryCamera]);

  const setRef = useCallback(
    (camera: CameraAngle, el: HTMLVideoElement | null) => {
      if (el) videoElsRef.current.set(camera, el);
      else videoElsRef.current.delete(camera);
    },
    []
  );

  // --- HLS helpers ---

  const handleVideoError = useCallback((cam: CameraAngle) => {
    setVideoErrors((prev) => new Set(prev).add(cam));
  }, []);

  const attachHls = useCallback((cam: CameraAngle, url: string) => {
    const video = videoElsRef.current.get(cam);
    if (!video) return;

    // Reuse existing HLS instance (avoids black flash between segments)
    const existing = hlsInstancesRef.current.get(cam);
    if (existing) {
      existing.loadSource(url);
      return;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 10,
        maxMaxBufferLength: 30,
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          console.warn(`HLS fatal error [${cam}]:`, data.type, data.details);
          handleVideoError(cam);
        }
      });
      hlsInstancesRef.current.set(cam, hls);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS
      video.src = url;
      video.load();
    }
  }, [handleVideoError]);

  // --- Stall detection ---

  const handleWaiting = useCallback((cam: CameraAngle) => {
    setBufferingCameras((prev) => new Set(prev).add(cam));
  }, []);

  const handlePlaying = useCallback((cam: CameraAngle) => {
    setBufferingCameras((prev) => {
      const next = new Set(prev);
      next.delete(cam);
      return next;
    });
  }, []);

  // --- Retry ---

  const retryCamera = useCallback((cam: CameraAngle) => {
    const seg = event.clips[segmentIdxRef.current];
    if (!seg || !seg.cameras.includes(cam)) return;

    setVideoErrors((prev) => {
      const next = new Set(prev);
      next.delete(cam);
      return next;
    });

    attachHls(cam, hlsManifestUrl(event.type, event.id, seg.timestamp, cam));

    // Sync to a healthy camera's current time
    const v = videoElsRef.current.get(cam);
    if (v) {
      const ref = findRefVideo();
      if (ref && ref !== v) v.currentTime = ref.currentTime;
      v.playbackRate = playbackRateRef.current;
      if (isPlayingRef.current) v.play().catch(() => {});
    }
  }, [event.clips, event.type, event.id, attachHls, findRefVideo]);

  // --- Resilient sync ---

  const syncAll = useCallback(() => {
    const ref = findRefVideo();
    if (!ref) return;

    const buffering = bufferingCamerasRef.current;
    const errors = videoErrorsRef.current;
    videoElsRef.current.forEach((v, cam) => {
      if (v === ref || !v.currentSrc) return;
      if (buffering.has(cam) || errors.has(cam)) return;
      if (Math.abs(v.currentTime - ref.currentTime) > SYNC_THRESHOLD) {
        v.currentTime = ref.currentTime;
      }
    });
  }, [findRefVideo]);

  // Periodic time + sync update + segment-end detection
  const advanceSegmentRef = useRef<() => void>(() => {});
  useEffect(() => {
    syncIntervalRef.current = setInterval(() => {
      // Skip time updates while loading a new segment (video currentTime is stale)
      if (segmentLoadingRef.current) return;

      const ref = findRefVideo();

      if (ref) {
        const t = (segmentOffsetsRef.current[segmentIdxRef.current] || 0) + ref.currentTime;
        setDisplayTime(t);
        displayTimeRef.current = t;

        // Find current telemetry frame via binary search on precomputed timestamps
        const td = telemetryDataRef.current;
        if (td && td.frames.length > 0) {
          const localTimeMs = ref.currentTime * 1000;
          let lo = 0, hi = td.frameTimesMs.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (td.frameTimesMs[mid] <= localTimeMs) lo = mid;
            else hi = mid - 1;
          }
          setCurrentTelemFrame(td.frames[lo]);
        }
      }
      if (isPlayingRef.current) {
        syncAll();
        // Auto-advance: when display time reaches the next segment boundary
        const segEnd = segmentOffsetsRef.current[segmentIdxRef.current + 1];
        if (segEnd !== undefined && displayTimeRef.current >= segEnd - 0.5) {
          advanceSegmentRef.current();
        }
      }
    }, SYNC_INTERVAL);
    return () => clearInterval(syncIntervalRef.current);
  }, [syncAll, findRefVideo]);

  // Load a segment into all video elements
  const loadSegment = useCallback(
    (idx: number, seekTime = 0) => {
      const seg = event.clips[idx];
      if (!seg) return;

      // Cancel any pending canplay listener from a previous loadSegment call
      canplayCleanupRef.current?.();
      canplayCleanupRef.current = null;
      clearTimeout(loadTimeoutRef.current);

      setVideoErrors(new Set());
      setBufferingCameras(new Set());
      setSegmentLoading(true);
      segmentLoadingRef.current = true;
      setTelemetryData(null);
      setCurrentTelemFrame(null);
      setTelemetryLoading(true);

      // Set displayTime immediately to avoid stale values during load
      const targetGlobalTime = (segmentOffsetsRef.current[idx] || 0) + seekTime;
      setDisplayTime(targetGlobalTime);
      displayTimeRef.current = targetGlobalTime;

      // Fetch telemetry in parallel (fire-and-forget, won't block video)
      const segTimestamp = seg.timestamp;
      fetchTelemetry(event.type, event.id, segTimestamp).then((data) => {
        // Guard against stale response from a previous segment's fetch
        const currentSeg = event.clips[segmentIdxRef.current];
        if (currentSeg?.timestamp !== segTimestamp) return;
        setTelemetryData(data);
        setTelemetryLoading(false);
      });

      // Attach HLS to available cameras; keep last frame for unavailable ones
      for (const cam of allEventCameras) {
        if (seg.cameras.includes(cam)) {
          attachHls(cam, hlsManifestUrl(event.type, event.id, seg.timestamp, cam));
        } else {
          // Keep last frame visible — just stop loading (prevents layout shift)
          const hls = hlsInstancesRef.current.get(cam);
          if (hls) hls.stopLoad();
          const video = videoElsRef.current.get(cam);
          if (video) video.pause();
        }
      }

      // Wait for ANY camera to be ready (resilient to individual camera failures)
      const segCameras = seg.cameras;
      let readyFired = false;
      const cleanups: (() => void)[] = [];

      const onReady = () => {
        if (readyFired) return;
        readyFired = true;
        cleanups.forEach(fn => fn());
        canplayCleanupRef.current = null;
        clearTimeout(loadTimeoutRef.current);
        setSegmentLoading(false);
        segmentLoadingRef.current = false;
        videoElsRef.current.forEach((v, cam) => {
          if (!segCameras.includes(cam)) return;
          v.currentTime = seekTime;
          v.playbackRate = playbackRateRef.current;
          if (isPlayingRef.current) v.play().catch(() => {});
        });
      };

      for (const camName of seg.cameras) {
        const cam = camName as CameraAngle;
        const hls = hlsInstancesRef.current.get(cam);
        if (hls) {
          // Use HLS.js event — works reliably for both fresh and reused instances
          // (canplay/readyState can be stale when HLS instance is reused)
          const hlsHandler = () => { hls.off(Hls.Events.FRAG_BUFFERED, hlsHandler); onReady(); };
          hls.on(Hls.Events.FRAG_BUFFERED, hlsHandler);
          cleanups.push(() => hls.off(Hls.Events.FRAG_BUFFERED, hlsHandler));
        } else {
          // Safari native HLS — use canplay
          const v = videoElsRef.current.get(cam);
          if (!v) continue;
          if (v.readyState >= 3) { onReady(); break; }
          const handler = () => onReady();
          v.addEventListener("canplay", handler, { once: true });
          cleanups.push(() => v.removeEventListener("canplay", handler));
        }
      }

      canplayCleanupRef.current = () => cleanups.forEach(fn => fn());

      // Safety timeout if no camera becomes ready (onReady is guarded by readyFired)
      loadTimeoutRef.current = setTimeout(onReady, 10000);

      // No video elements available — clear loading state immediately
      if (cleanups.length === 0 && !readyFired) {
        setSegmentLoading(false);
        segmentLoadingRef.current = false;
      }
    },
    [event.clips, event.type, event.id, allEventCameras, attachHls]
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

    // Destroy all HLS instances (fresh start for new event)
    hlsInstancesRef.current.forEach((hls) => hls.destroy());
    hlsInstancesRef.current.clear();

    segmentIdxRef.current = 0;
    setSegmentIdx(0);
    setDisplayTime(0);
    displayTimeRef.current = 0;
    setVideoErrors(new Set());
    setBufferingCameras(new Set());
    setTelemetryData(null);
    setCurrentTelemFrame(null);

    loadSegment(0, 0);
  }, [event.id, loadSegment]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimeout(loadTimeoutRef.current);
      canplayCleanupRef.current?.();
      hlsInstancesRef.current.forEach((hls) => hls.destroy());
      hlsInstancesRef.current.clear();
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
        case "t":
          setShowTelemetry((s) => !s);
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
  }, [togglePlay, seekTo, onBack, onNavigate, hasPrev, hasNext, toggleMute, allEventCameras, showShortcuts]);

  // Compute cell position based on layout
  // Uses allEventCameras index for stable grid positions (prevents layout shift on segment change)
  const getCellStyle = (
    cam: CameraAngle,
    allIdx: number,
    isActive: boolean
  ): React.CSSProperties => {
    if (layout === "grid") {
      const [col, row] = GRID_POS[allIdx] || [1, 1];
      return {
        gridColumn: col,
        gridRow: row,
        visibility: isActive ? "visible" : "hidden",
      };
    }
    if (!isActive) return { display: "none" };
    if (cam === effectiveFocusCamera) {
      return { gridColumn: 1, gridRow: "1 / -1" };
    }
    return { gridColumn: 2 };
  };

  const getContainerStyle = (): React.CSSProperties => {
    if (layout === "grid") {
      return {
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gridTemplateRows: "repeat(2, minmax(0, 1fr))",
      };
    }
    const sidebarCount = Math.max(allEventCameras.length - 1, 1);
    return {
      gridTemplateRows: `repeat(${sidebarCount}, minmax(0, 1fr))`,
    };
  };

  const { label: badgeLabel, color: badgeColor } = BADGE_MAP[event.type];

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

  // Zoom/pan calculations for the player timeline
  const viewDuration = totalDuration / zoomLevel;
  const viewStart = Math.max(0, Math.min(viewCenter - viewDuration / 2, totalDuration - viewDuration));
  const viewEnd = viewStart + viewDuration;
  const isZoomed = zoomLevel > 1;

  // Convert a time value to a percentage within the visible viewport
  const timeToViewPct = (t: number): number => ((t - viewStart) / viewDuration) * 100;

  // Pre-compute trigger marker position (null if out of viewport)
  const triggerPct = triggerTimeGlobal != null && totalDuration > 0
    ? timeToViewPct(triggerTimeGlobal)
    : null;
  const showTriggerMarker = triggerPct != null && triggerPct >= -1 && triggerPct <= 101;

  // Auto-follow playhead during playback (keep it visible)
  useEffect(() => {
    if (!isPlaying || !isZoomed) return;
    if (displayTime < viewStart || displayTime > viewEnd) {
      setViewCenter(displayTime);
    }
  }, [isPlaying, isZoomed, displayTime, viewStart, viewEnd]);

  // Reset zoom when event changes
  useEffect(() => {
    setZoomLevel(1);
    setViewCenter(0);
  }, [event.type, event.id]);

  // Attach wheel listener with { passive: false } to allow preventDefault
  const timelineRef = useRef<HTMLDivElement>(null);
  const totalDurationRef = useRef(totalDuration);
  totalDurationRef.current = totalDuration;

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      const td = totalDurationRef.current;
      if (td <= 0) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseX = (e.clientX - rect.left) / rect.width;
      const zoomFactor = e.deltaY < 0 ? 1.3 : 1 / 1.3;
      // Functional updates handle rapid sequential scroll events correctly
      setZoomLevel(prevZoom => {
        const newZoom = Math.max(1, Math.min(50, prevZoom * zoomFactor));
        setViewCenter(prevCenter => {
          const prevDur = td / prevZoom;
          const vs = Math.max(0, Math.min(prevCenter - prevDur / 2, td - prevDur));
          const mouseTime = vs + mouseX * prevDur;
          const newDur = td / newZoom;
          const newCenter = mouseTime - (mouseX - 0.5) * newDur;
          return Math.max(newDur / 2, Math.min(td - newDur / 2, newCenter));
        });
        return newZoom;
      });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const handleTimelineClick = useCallback((e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = viewStart + pct * viewDuration;
    seekTo(time);
  }, [viewStart, viewDuration, seekTo]);

  const handleTimelineMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverTime(viewStart + pct * viewDuration);
  }, [viewStart, viewDuration]);

  // Minimap drag to pan
  const minimapDragRef = useRef(false);
  const handleMinimapPointerDown = useCallback((e: React.PointerEvent) => {
    minimapDragRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    setViewCenter(pct * totalDuration);
  }, [totalDuration]);
  const handleMinimapPointerMove = useCallback((e: React.PointerEvent) => {
    if (!minimapDragRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setViewCenter(pct * totalDuration);
  }, [totalDuration]);
  const handleMinimapPointerUp = useCallback(() => {
    minimapDragRef.current = false;
  }, []);

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
            style={{ background: badgeColor }}
          >
            {badgeLabel}
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
                timeZoneName: "short",
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
                ["T", "Toggle telemetry HUD"],
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
        {ALL_CAMERAS.map((cam, allIdx) => {
          const isActive = activeCameras.includes(cam);
          const isFocused = cam === effectiveFocusCamera && layout === "focus";
          const isOverlayCam = (layout === "focus" && cam === effectiveFocusCamera) ||
            (layout === "grid" && cam === "front");
          const showOverlay = showTelemetry && currentTelemFrame && isOverlayCam;
          const showTelemLoading = showTelemetry && telemetryLoading && !currentTelemFrame && isOverlayCam;
          return (
            <div
              key={cam}
              className={`player-video-cell ${isFocused ? "focused" : ""}`}
              style={getCellStyle(cam, allIdx, isActive)}
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
              onDoubleClick={isFocused ? toggleFullscreen : undefined}
            >
              <video
                ref={(el) => setRef(cam, el)}
                muted={cam === "front" ? isMuted : true}
                playsInline
                aria-label={`${CAMERA_LABELS[cam]} camera`}
                onError={(e) => {
                  // Only report error if video has media loaded (ignore errors from clearing src)
                  if ((e.target as HTMLVideoElement).currentSrc) handleVideoError(cam);
                }}
                onWaiting={() => handleWaiting(cam)}
                onPlaying={() => handlePlaying(cam)}
              />
              <span className="player-cam-label">{CAMERA_LABELS[cam]}</span>
              {bufferingCameras.has(cam) && !videoErrors.has(cam) && (
                <span className="player-video-buffering">Buffering...</span>
              )}
              {videoErrors.has(cam) && (
                <button
                  className="player-video-error player-video-retry"
                  onClick={(e) => { e.stopPropagation(); retryCamera(cam); }}
                >
                  Failed to load &middot; Retry
                </button>
              )}
              {showOverlay && <TelemetryOverlay frame={currentTelemFrame} />}
              {showTelemLoading && <div className="telem-loading">Loading telemetry...</div>}
            </div>
          );
        })}
        {segmentLoading && (
          <div className="player-loading-overlay">Loading segment...</div>
        )}
        {activeCameras.length > 0 && activeCameras.every((c) => videoErrors.has(c)) && (
          <div className="player-loading-overlay">
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

        {triggerTimeGlobal != null && (
          <button
            onClick={() => seekTo(triggerTimeGlobal)}
            className="player-trigger-btn"
            title="Jump to event trigger"
            aria-label="Jump to event trigger"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2L1 21h22L12 2zm0 4l7.5 13h-15L12 6z"/>
              <rect x="11" y="10" width="2" height="4"/>
              <rect x="11" y="16" width="2" height="2"/>
            </svg>
          </button>
        )}

        <span className="player-time">
          {formatTime(displayTime)} / {formatTime(totalDuration)}
        </span>

        <div className="player-timeline-wrapper">
          <div
            ref={timelineRef}
            className={`player-timeline ${isZoomed ? "zoomed" : ""}`}
            onMouseMove={handleTimelineMouseMove}
            onMouseLeave={() => setHoverTime(null)}
            onClick={handleTimelineClick}
          >
            <div
              className="player-timeline-progress"
              style={{
                left: `${Math.max(0, timeToViewPct(0))}%`,
                width: `${Math.min(timeToViewPct(displayTime), 100) - Math.max(0, timeToViewPct(0))}%`,
              }}
            />
            {/* Segment boundary markers */}
            {event.clips.length > 1 && event.clips.slice(1).map((_, i) => {
              const pct = timeToViewPct(segmentOffsets[i + 1]);
              if (pct < -1 || pct > 101) return null;
              return (
                <div
                  key={i}
                  className="player-timeline-marker"
                  style={{ left: `${pct}%` }}
                />
              );
            })}
            {/* Event trigger time marker */}
            {showTriggerMarker && (
              <div
                className="player-timeline-trigger"
                style={{ left: `${triggerPct}%` }}
                title="Event trigger time"
              />
            )}
            {hoverTime != null && (
              <span
                className="player-timeline-tooltip"
                style={{ left: `${timeToViewPct(hoverTime)}%` }}
              >
                {formatTime(hoverTime)}
              </span>
            )}
            {segmentLoading && (
              <span className="player-timeline-loading">Loading...</span>
            )}
          </div>
          {/* Minimap: shows full timeline with viewport indicator */}
          {isZoomed && (
            <div
              className="player-minimap"
              onPointerDown={handleMinimapPointerDown}
              onPointerMove={handleMinimapPointerMove}
              onPointerUp={handleMinimapPointerUp}
            >
              <div
                className="player-minimap-progress"
                style={{ width: `${(displayTime / totalDuration) * 100}%` }}
              />
              {/* Segment markers on minimap */}
              {event.clips.length > 1 && event.clips.slice(1).map((_, i) => (
                <div
                  key={i}
                  className="player-minimap-marker"
                  style={{ left: `${(segmentOffsets[i + 1] / totalDuration) * 100}%` }}
                />
              ))}
              {/* Viewport indicator */}
              <div
                className="player-minimap-viewport"
                style={{
                  left: `${(viewStart / totalDuration) * 100}%`,
                  width: `${(viewDuration / totalDuration) * 100}%`,
                }}
              />
            </div>
          )}
          {isZoomed && (
            <button
              className="player-zoom-reset"
              onClick={() => { setZoomLevel(1); setViewCenter(0); }}
              title="Reset zoom"
            >
              {zoomLevel.toFixed(1)}x
            </button>
          )}
        </div>

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
