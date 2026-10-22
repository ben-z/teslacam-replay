import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import Hls from "hls.js";
import { hlsManifestUrl } from "../api";
import type { DashcamEvent, CameraAngle } from "../types";
import { ALL_CAMERAS, CAMERA_LABELS, formatReason } from "../types";
import { useTelemetry } from "../useTelemetry";
import { TelemetryOverlay } from "./TelemetryOverlay";
import { hasReachedPlaybackEnd, playbackBoundary, playbackTimeline, recordingWallTimeMs, type CompletedDurations } from "../playback";
import "./Player.css";

interface Props {
  event: DashcamEvent;
  onBack: () => void;
  onRefresh: () => void;
  onNavigate?: (direction: -1 | 1) => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  onTimeUpdate?: (time: number, isPlaying: boolean) => void;
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
const PARENT_TIME_UPDATE_INTERVAL = 500; // ms - compact timeline does not need every sync tick
const NEXT_SEGMENT_PREFETCH_WINDOW = 15; // seconds before boundary
const HLS_LOAD_TIMEOUT_MS = 120_000; // first-run server-side segmentation can take tens of seconds
const SEGMENT_READY_TIMEOUT_MS = 60_000;
const WALL_CLOCK_FORMATTER = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
});
const HEADER_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

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

export function Player({ event, onBack, onRefresh, onNavigate, hasPrev, hasNext, onTimeUpdate }: Props) {
  const [layout, setLayout] = useState<Layout>("grid");
  const [focusCamera, setFocusCamera] = useState<CameraAngle>("front");
  const [isPlaying, setIsPlaying] = useState(false);
  const [displayTime, setDisplayTime] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [segmentIdx, setSegmentIdx] = useState(0);

  const [videoErrors, setVideoErrors] = useState<Set<CameraAngle>>(new Set());
  const [bufferingCameras, setBufferingCameras] = useState<Set<CameraAngle>>(new Set());
  const [endedCameras, setEndedCameras] = useState<Set<CameraAngle>>(new Set());
  const [segmentLoading, setSegmentLoading] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [viewCenter, setViewCenter] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const shortcutsCloseRef = useRef<HTMLButtonElement>(null);
  const [showTelemetry, setShowTelemetry] = useState(true);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const eventKey = `${event.type}/${event.id}`;
  const [completedDurationState, setCompletedDurationState] = useState<{ eventKey: string; durations: CompletedDurations }>({ eventKey, durations: {} });
  const completedDurations = completedDurationState.eventKey === eventKey ? completedDurationState.durations : {};
  const completedDurationsRef = useRef(completedDurations);
  completedDurationsRef.current = completedDurations;
  const hlsSourcesRef = useRef<Map<CameraAngle, { url: string; eventKey: string; timestamp: string }>>(new Map());
  const eventKeyRef = useRef(eventKey);
  eventKeyRef.current = eventKey;

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
  const bufferingCamerasRef = useRef<Set<CameraAngle>>(new Set());
  const videoErrorsRef = useRef<Set<CameraAngle>>(new Set());
  const endedCamerasRef = useRef<Set<CameraAngle>>(new Set());
  const onTimeUpdateRef = useRef(onTimeUpdate);
  const lastParentTimeUpdateRef = useRef({ time: -1, playing: false, at: 0 });
  const prefetchedSegmentsRef = useRef<Set<string>>(new Set());
  onTimeUpdateRef.current = onTimeUpdate;

  // Keep refs in sync with state (displayTimeRef is omitted — it's the
  // source of truth, written by the sync interval and seekTo/loadSegment)
  playbackRateRef.current = playbackRate;
  bufferingCamerasRef.current = bufferingCameras;
  videoErrorsRef.current = videoErrors;
  endedCamerasRef.current = endedCameras;

  const timeline = useMemo(() => playbackTimeline(event.clips, completedDurations), [event.clips, completedDurations]);
  const completedSegments = event.clips.map((clip) => clip.cameras.length > 0 && clip.cameras.every((camera) => completedDurations[clip.timestamp]?.[camera] !== undefined));
  const segmentOffsets = timeline.offsets;

  segmentOffsetsRef.current = segmentOffsets;

  const finalDurationKnown = Boolean(completedSegments.at(-1));
  const totalDuration = finalDurationKnown ? segmentOffsets[segmentOffsets.length - 1] : Math.max(segmentOffsets[segmentOffsets.length - 1], displayTime);

  // Telemetry: fetches per-segment, syncs frame to displayTime
  const { frame: currentTelemFrame, loading: telemetryLoading, error: telemetryError } =
    useTelemetry(event, segmentIdx, displayTime, segmentOffsets);

  // Compute trigger time position on the seek bar (Sentry/Saved only)
  const triggerTimeGlobal = useMemo(() => {
    if (event.type === "RecentClips" || !event.timestamp) return null;
    const triggerEpoch = recordingWallTimeMs(event.timestamp) / 1000;

    // Parse clip timestamps once (shared between both passes)
    const clipEpochs = event.clips.map((clip) => {
      return recordingWallTimeMs(clip.timestamp) / 1000;
    });

    // Pass 1: find which segment the trigger falls within
    for (let i = 0; i < clipEpochs.length; i++) {
      if (isNaN(clipEpochs[i])) continue;
      const offsetInClip = triggerEpoch - clipEpochs[i];
      if (offsetInClip >= 0 && offsetInClip <= timeline.durations[i]) {
        return segmentOffsets[i] + offsetInClip;
      }
    }
    return null;
  }, [event.type, event.timestamp, event.clips, segmentOffsets, timeline.durations]);

  const segment = event.clips[segmentIdx];
  const inRecordingGap = Boolean(segment && completedSegments[segmentIdx] && segmentIdx < event.clips.length - 1 && displayTime >= segmentOffsets[segmentIdx] + timeline.durations[segmentIdx] && displayTime < segmentOffsets[segmentIdx + 1]);

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
  const allCamerasFailed = activeCameras.length > 0 && activeCameras.every((camera) => videoErrors.has(camera));

  // Guard: if focusCamera is not in active set, fall back to front or first available
  let effectiveFocusCamera = focusCamera;
  if (!activeCameras.includes(focusCamera)) {
    if (activeCameras.includes("front")) {
      effectiveFocusCamera = "front";
    } else {
      effectiveFocusCamera = activeCameras[0] ?? focusCamera;
    }
  }

  const setRef = useCallback(
    (camera: CameraAngle, el: HTMLVideoElement | null) => {
      if (el) videoElsRef.current.set(camera, el);
      else videoElsRef.current.delete(camera);
    },
    []
  );

  const notifyTimeUpdate = useCallback((time: number, playing: boolean, force = false) => {
    const callback = onTimeUpdateRef.current;
    if (!callback) return;

    const now = performance.now();
    const last = lastParentTimeUpdateRef.current;
    if (
      !force &&
      playing === last.playing &&
      Math.abs(time - last.time) < 0.5 &&
      now - last.at < PARENT_TIME_UPDATE_INTERVAL
    ) {
      return;
    }

    lastParentTimeUpdateRef.current = { time, playing, at: now };
    callback(time, playing);
  }, []);

  // --- HLS helpers ---

  const handleVideoError = useCallback((cam: CameraAngle) => {
    const errors = new Set(videoErrorsRef.current);
    errors.add(cam);
    videoErrorsRef.current = errors;
    setVideoErrors(errors);
    // Destroy HLS instance on fatal error — HLS.js can't recover in-place.
    // attachHls will create a fresh instance when the camera is retried.
    const hls = hlsInstancesRef.current.get(cam);
    if (hls) { hls.destroy(); hlsInstancesRef.current.delete(cam); }
    if (activeCamerasRef.current.length > 0 && activeCamerasRef.current.every((camera) => errors.has(camera))) {
      clearTimeout(loadTimeoutRef.current);
      canplayCleanupRef.current?.();
      canplayCleanupRef.current = null;
      segmentLoadingRef.current = false;
      setSegmentLoading(false);
      isPlayingRef.current = false;
      setIsPlaying(false);
      videoElsRef.current.forEach((video) => video.pause());
      notifyTimeUpdate(displayTimeRef.current, false, true);
    }
  }, [notifyTimeUpdate]);

  const playCamera = useCallback((camera: CameraAngle, video: HTMLVideoElement) => {
    if (videoErrorsRef.current.has(camera)) return;
    const source = hlsSourcesRef.current.get(camera);
    video.play().catch((error: unknown) => {
      // Pausing or replacing a source intentionally cancels its pending play.
      if (!isPlayingRef.current || hlsSourcesRef.current.get(camera) !== source) return;
      isPlayingRef.current = false;
      setIsPlaying(false);
      videoElsRef.current.forEach((element) => element.pause());
      setPlaybackError(error instanceof Error ? error.message : String(error));
      notifyTimeUpdate(displayTimeRef.current, false, true);
    });
  }, [notifyTimeUpdate]);

  const recordCompletedDuration = useCallback((cam: CameraAngle, url: string, duration: number) => {
    const source = hlsSourcesRef.current.get(cam);
    if (!source || source.eventKey !== eventKeyRef.current || source.url !== new URL(url, location.href).href) return;
    if (!Number.isFinite(duration) || duration <= 0) {
      console.error(`Invalid completed video duration for ${source.timestamp}/${cam}: ${duration}`);
      handleVideoError(cam);
      return;
    }
    setCompletedDurationState((previous) => {
      const durations = previous.eventKey === source.eventKey ? previous.durations : {};
      if (durations[source.timestamp]?.[cam] === duration) return previous;
      return {
        eventKey: source.eventKey,
        durations: { ...durations, [source.timestamp]: { ...durations[source.timestamp], [cam]: duration } },
      };
    });
  }, [handleVideoError]);

  const attachHls = useCallback((cam: CameraAngle, url: string, timestamp: string) => {
    const video = videoElsRef.current.get(cam);
    if (!video) return;
    hlsSourcesRef.current.set(cam, { url: new URL(url, location.href).href, eventKey: eventKeyRef.current, timestamp });

    // Reuse existing HLS instance (avoids black flash between segments)
    const existing = hlsInstancesRef.current.get(cam);
    if (existing) {
      existing.loadSource(url);
      return;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        startPosition: 0,
        maxBufferLength: 10,
        maxMaxBufferLength: 30,
        manifestLoadingTimeOut: HLS_LOAD_TIMEOUT_MS,
        levelLoadingTimeOut: HLS_LOAD_TIMEOUT_MS,
        fragLoadingTimeOut: HLS_LOAD_TIMEOUT_MS,
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          console.warn(`HLS fatal error [${cam}]:`, data.type, data.details);
          handleVideoError(cam);
        }
      });
      hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
        if (!data.details.live) recordCompletedDuration(cam, data.details.url, data.details.totalduration);
      });
      hlsInstancesRef.current.set(cam, hls);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS
      video.src = url;
      video.load();
    } else {
      handleVideoError(cam);
    }
  }, [handleVideoError, recordCompletedDuration]);

  // --- Stall detection ---

  const handleEnded = useCallback((cam: CameraAngle) => {
    // Ignore ended events during segment loading (stale events from previous segment)
    if (segmentLoadingRef.current) return;
    const video = videoElsRef.current.get(cam);
    const source = hlsSourcesRef.current.get(cam);
    if (video && source) {
      recordCompletedDuration(cam, source.url, video.duration);
    }
    setEndedCameras((prev) => {
      if (prev.has(cam)) return prev;
      const next = new Set(prev);
      next.add(cam);
      return next;
    });
  }, [recordCompletedDuration]);

  const handleWaiting = useCallback((cam: CameraAngle) => {
    setBufferingCameras((prev) => {
      if (prev.has(cam)) return prev;
      const next = new Set(prev);
      next.add(cam);
      return next;
    });
  }, []);

  const handlePlaying = useCallback((cam: CameraAngle) => {
    setBufferingCameras((prev) => {
      if (!prev.has(cam)) return prev;
      const next = new Set(prev);
      next.delete(cam);
      return next;
    });
    setEndedCameras((prev) => {
      if (!prev.has(cam)) return prev;
      const next = new Set(prev);
      next.delete(cam);
      return next;
    });
  }, []);

  // --- Retry ---

  const retryCamera = useCallback((cam: CameraAngle) => {
    const seg = event.clips[segmentIdxRef.current];
    if (!seg || !seg.cameras.includes(cam)) return;

    const errors = new Set(videoErrorsRef.current);
    errors.delete(cam);
    videoErrorsRef.current = errors;
    setVideoErrors(errors);

    attachHls(cam, hlsManifestUrl(event.type, event.id, seg.timestamp, cam), seg.timestamp);

    // Sync to current displayTime
    const v = videoElsRef.current.get(cam);
    if (v) {
      v.currentTime = displayTimeRef.current - (segmentOffsetsRef.current[segmentIdxRef.current] || 0);
      v.playbackRate = playbackRateRef.current;
      if (isPlayingRef.current) playCamera(cam, v);
    }
  }, [event.clips, event.type, event.id, attachHls, playCamera]);

  // Videos share a recording-clock position. Missing intervals retain their
  // original positions; the next segment starts at its recorded timestamp.
  const advanceSegmentRef = useRef<() => void>(() => {});
  const lastTickRef = useRef(0);
  useEffect(() => {
    syncIntervalRef.current = setInterval(() => {
      const now = performance.now();
      const elapsed = lastTickRef.current > 0
        ? (now - lastTickRef.current) / 1000 * playbackRateRef.current
        : 0;
      lastTickRef.current = now;

      if (segmentLoadingRef.current) return;

      const segOff = segmentOffsetsRef.current[segmentIdxRef.current] || 0;
      const active = activeCamerasRef.current;
      const errors = videoErrorsRef.current;
      const buffering = bufferingCamerasRef.current;
      const playable = active.filter((cam) => !errors.has(cam));
      if (isPlayingRef.current && active.length > 0 && playable.length === 0) {
        isPlayingRef.current = false;
        setIsPlaying(false);
        notifyTimeUpdate(displayTimeRef.current, false, true);
        return;
      }
      const cameraDurations = playable.map((cam) => {
        const source = hlsSourcesRef.current.get(cam);
        return source ? completedDurationsRef.current[source.timestamp]?.[cam] : undefined;
      });
      const nextStart = segmentIdxRef.current < segmentOffsetsRef.current.length - 2 ? segmentOffsetsRef.current[segmentIdxRef.current + 1] : null;
      const boundary = playbackBoundary(segOff, nextStart, cameraDurations);
      const allEnded = hasReachedPlaybackEnd(playable.map((camera) => ({ ended: Boolean(videoElsRef.current.get(camera)?.ended) })));
      if (isPlayingRef.current && allEnded) {
        const actualEnd = segOff + Math.max(...playable.map((camera) => videoElsRef.current.get(camera)!.currentTime));
        displayTimeRef.current = actualEnd;
        setDisplayTime(actualEnd);
        advanceSegmentRef.current();
        return;
      }

      const hasPlayingVideo = playable.some((cam) => {
        const video = videoElsRef.current.get(cam);
        return video && !video.paused && !video.ended && !buffering.has(cam) && video.readyState >= 3;
      });
      if (isPlayingRef.current && hasPlayingVideo) {
        const nextTime = displayTimeRef.current + elapsed;
        displayTimeRef.current = boundary === null ? nextTime : Math.min(nextTime, boundary);
        setDisplayTime(displayTimeRef.current);
        notifyTimeUpdate(displayTimeRef.current, true);
      }

      // 2. Sync each video independently to displayTime
      const expectedLocal = displayTimeRef.current - segOff;
      const finishingLastSegment = nextStart === null && boundary !== null && displayTimeRef.current >= boundary;

      for (const cam of active) {
        const v = videoElsRef.current.get(cam);
        if (!v?.currentSrc || errors.has(cam)) continue;
        // Skip videos past their data range (short cameras)
        if (v.ended || (isFinite(v.duration) && expectedLocal > v.duration + 0.5)) continue;
        // Resume videos that should be playing but got paused (e.g., ended then seeked)
        if (isPlayingRef.current && v.paused && !buffering.has(cam)) {
          playCamera(cam, v);
        }
        // Correct drift — only when video has data ready
        if (!finishingLastSegment && !buffering.has(cam) && Math.abs(v.currentTime - expectedLocal) > SYNC_THRESHOLD) {
          v.currentTime = expectedLocal;
        }
      }

      // 3. Auto-advance at segment boundary
      if (isPlayingRef.current) {
        if (hasPlayingVideo && nextStart !== null && boundary !== null && displayTimeRef.current >= boundary) {
          advanceSegmentRef.current();
        }
      }
    }, SYNC_INTERVAL);
    return () => clearInterval(syncIntervalRef.current);
  }, []);

  // Load a segment into all video elements
  const loadSegment = useCallback(
    (idx: number, seekTime = 0) => {
      const seg = event.clips[idx];
      if (!seg) return;

      // Cancel any pending canplay listener from a previous loadSegment call
      canplayCleanupRef.current?.();
      canplayCleanupRef.current = null;
      clearTimeout(loadTimeoutRef.current);

      videoErrorsRef.current = new Set();
      setVideoErrors(videoErrorsRef.current);
      setBufferingCameras(new Set());
      setEndedCameras(new Set());
      setPlaybackError(null);
      setSegmentLoading(true);
      segmentLoadingRef.current = true;

      // Set displayTime immediately to avoid stale values during load
      const targetGlobalTime = (segmentOffsetsRef.current[idx] || 0) + seekTime;
      setDisplayTime(targetGlobalTime);
      displayTimeRef.current = targetGlobalTime;

      // Attach HLS to available cameras; keep last frame for unavailable ones
      for (const cam of allEventCameras) {
        if (seg.cameras.includes(cam)) {
          attachHls(cam, hlsManifestUrl(event.type, event.id, seg.timestamp, cam), seg.timestamp);
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
        // Use displayTimeRef for the latest position (user may have seeked during load)
        const localT = displayTimeRef.current - (segmentOffsetsRef.current[idx] || 0);
        videoElsRef.current.forEach((v, cam) => {
          if (!segCameras.includes(cam)) return;
          v.currentTime = Math.max(0, localT);
          v.playbackRate = playbackRateRef.current;
          if (isPlayingRef.current) playCamera(cam, v);
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
      loadTimeoutRef.current = setTimeout(onReady, SEGMENT_READY_TIMEOUT_MS);

      // No video elements available — clear loading state immediately
      if (cleanups.length === 0 && !readyFired) {
        setSegmentLoading(false);
        segmentLoadingRef.current = false;
      }
    },
    [event.clips, event.type, event.id, allEventCameras, attachHls, playCamera]
  );

  // Advance to next segment
  const advanceSegment = useCallback(() => {
    const nextIdx = segmentIdxRef.current + 1;
    if (nextIdx >= event.clips.length) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      videoElsRef.current.forEach((video) => video.pause());
      notifyTimeUpdate(displayTimeRef.current, false, true);
      return;
    }
    segmentIdxRef.current = nextIdx;
    setSegmentIdx(nextIdx);
    loadSegment(nextIdx, 0);
  }, [event.clips.length, loadSegment, notifyTimeUpdate]);
  advanceSegmentRef.current = advanceSegment;

  // Seek to global time
  const seekTo = useCallback(
    (globalTime: number) => {
      const offsets = segmentOffsetsRef.current;
      const clamped = Math.max(0, Math.min(globalTime, totalDuration));
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
        // Failed cameras remain available through their explicit Retry control.
        setEndedCameras(new Set());
        videoElsRef.current.forEach((v, cam) => {
          if (!activeCamerasRef.current.includes(cam) || videoErrorsRef.current.has(cam) || !v.currentSrc) return;
          v.currentTime = localTime;
          if (isPlayingRef.current) playCamera(cam, v);
        });
      }
      setDisplayTime(clamped);
      displayTimeRef.current = clamped;
      notifyTimeUpdate(clamped, isPlayingRef.current, true);
    },
    [event.clips, loadSegment, totalDuration, playCamera]
  );

  // Play/Pause
  const togglePlay = useCallback(() => {
    if (activeCamerasRef.current.length === 0) return;
    if (isPlayingRef.current) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      videoElsRef.current.forEach((v) => v.pause());
      notifyTimeUpdate(displayTimeRef.current, false, true);
    } else {
      setPlaybackError(null);
      const atLastSegment = segmentIdxRef.current === event.clips.length - 1;
      const playable = activeCamerasRef.current.filter((camera) => !videoErrorsRef.current.has(camera));
      const atAvailableEnd = hasReachedPlaybackEnd(playable.map((camera) => ({ ended: Boolean(videoElsRef.current.get(camera)?.ended) })));
      if (atLastSegment && atAvailableEnd) seekTo(0);
      isPlayingRef.current = true;
      setIsPlaying(true);
      videoElsRef.current.forEach((v, cam) => {
        if (!activeCamerasRef.current.includes(cam) || videoErrorsRef.current.has(cam) || !v.currentSrc) return;
        v.playbackRate = playbackRateRef.current;
        playCamera(cam, v);
      });
      notifyTimeUpdate(displayTimeRef.current, true, true);
    }
  }, [event.clips.length, seekTo, notifyTimeUpdate, playCamera]);

  useEffect(() => {
    if (finalDurationKnown && displayTimeRef.current > totalDuration) {
      displayTimeRef.current = totalDuration;
      setDisplayTime(totalDuration);
      notifyTimeUpdate(totalDuration, isPlayingRef.current, true);
    }
  }, [finalDurationKnown, totalDuration, notifyTimeUpdate]);

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

  // Prepare the next segment shortly before playback reaches it. The fetches
  // trigger the server's lazy HLS cache so segment transitions are less likely
  // to block on ffmpeg work.
  useEffect(() => {
    if (!isPlaying || segmentLoading) return;

    const nextIdx = segmentIdx + 1;
    const nextSegment = event.clips[nextIdx];
    if (!nextSegment) return;

    const nextOffset = segmentOffsets[nextIdx];
    if (nextOffset == null || nextOffset - displayTime > NEXT_SEGMENT_PREFETCH_WINDOW) return;

    const prefetchKey = `${event.type}/${event.id}/${nextSegment.timestamp}`;
    if (prefetchedSegmentsRef.current.has(prefetchKey)) return;
    prefetchedSegmentsRef.current.add(prefetchKey);

    for (const cam of allEventCameras) {
      if (!nextSegment.cameras.includes(cam)) continue;
      fetch(hlsManifestUrl(event.type, event.id, nextSegment.timestamp, cam), { cache: "no-store" })
        .catch(() => {});
    }
  }, [
    allEventCameras,
    displayTime,
    event.clips,
    event.id,
    event.type,
    isPlaying,
    segmentIdx,
    segmentLoading,
    segmentOffsets,
  ]);

  // Reset state and load first segment when event changes
  useEffect(() => {
    // Stop existing playback
    isPlayingRef.current = false;
    setIsPlaying(false);
    videoElsRef.current.forEach((v) => v.pause());

    // Destroy all HLS instances (fresh start for new event)
    hlsInstancesRef.current.forEach((hls) => hls.destroy());
    hlsInstancesRef.current.clear();
    hlsSourcesRef.current.clear();
    setCompletedDurationState({ eventKey, durations: {} });

    segmentIdxRef.current = 0;
    setSegmentIdx(0);
    setDisplayTime(0);
    displayTimeRef.current = 0;
    setVideoErrors(new Set());
    setBufferingCameras(new Set());
    setEndedCameras(new Set());
    prefetchedSegmentsRef.current.clear();

    loadSegment(0, 0);
  }, [eventKey, loadSegment]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimeout(loadTimeoutRef.current);
      canplayCleanupRef.current?.();
      hlsInstancesRef.current.forEach((hls) => hls.destroy());
      hlsInstancesRef.current.clear();
      hlsSourcesRef.current.clear();
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
    if (!showShortcuts) return;
    const previous = document.activeElement;
    shortcutsCloseRef.current?.focus();
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, [showShortcuts]);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (showShortcuts) {
        if (e.key === "Escape") setShowShortcuts(false);
        return;
      }
      if (t.closest("input, textarea, select, button, a, [role='slider']") || t.isContentEditable) return;
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

  // Wall-clock time: compute from first clip timestamp + displayTime
  const wallClockBaseMs = useMemo(() => {
    if (!event.clips[0]?.timestamp) return null;
    return recordingWallTimeMs(event.clips[0].timestamp);
  }, [event.clips]);

  const wallClockDisplay = wallClockBaseMs != null
    ? WALL_CLOCK_FORMATTER.format(new Date(wallClockBaseMs + displayTime * 1000))
    : null;
  const headerDateDisplay = useMemo(
    () => HEADER_DATE_FORMATTER.format(recordingWallTimeMs(event.timestamp)),
    [event.timestamp]
  );

  const { label: badgeLabel, color: badgeColor } = BADGE_MAP[event.type];

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

  const navigation = (
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
          <button onClick={onRefresh} className="player-back-btn player-refresh-btn" aria-label="Refresh recording" title="Reload this recording's event details">Refresh</button>
        </div>
  );

  if (allEventCameras.length === 0) {
    return (
      <div className="player-container">
        <header className="player-header">
          {navigation}
          <span className="player-header-title">No archived video</span>
        </header>
        <div className="player-empty">
          <p>This event has no playable video files in the archive.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="player-container" ref={containerRef}>
      {/* Header */}
      <header className="player-header">
        {navigation}
        <div className="player-header-info">
          <span
            className="player-badge"
            style={{ background: badgeColor }}
          >
            {badgeLabel}
          </span>
          <span className="player-header-title">
            {event.city || event.id}
            <span className="player-header-date" title="Recorded local time">
              {" "}&middot;{" "}
              {headerDateDisplay}
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
        {layout === "focus" && (
          <label className="player-camera-picker">
            Camera
            <select className="player-camera-select" aria-label="Focused camera" value={effectiveFocusCamera} onChange={(e) => setFocusCamera(e.target.value as CameraAngle)}>
              {activeCameras.map((camera) => <option key={camera} value={camera}>{CAMERA_LABELS[camera]}</option>)}
            </select>
          </label>
        )}
        <button
          className="player-shortcuts-hint"
          onClick={() => setShowShortcuts((s) => !s)}
          aria-label="Keyboard shortcuts"
        >
          ?
        </button>
      </header>

      {telemetryError && <p className="player-media-status" role="alert">Telemetry could not be loaded: {telemetryError}</p>}
      {playbackError && <p className="player-media-status" role="alert">Playback could not start: {playbackError}</p>}
      {allCamerasFailed && (
        <p className="player-media-status" role="alert">All cameras failed to load for this segment. Retry a camera to try again.</p>
      )}

      {showShortcuts && (
        <div className="player-shortcuts-overlay" onClick={() => setShowShortcuts(false)}>
          <div className="player-shortcuts-panel" role="dialog" aria-modal="true" aria-labelledby="player-shortcuts-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Tab") { e.preventDefault(); shortcutsCloseRef.current?.focus(); } }}>
            <div className="player-shortcuts-title" id="player-shortcuts-title">
              Keyboard Shortcuts
              <button ref={shortcutsCloseRef} className="player-shortcuts-close" onClick={() => setShowShortcuts(false)} aria-label="Close">&times;</button>
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
          const showOverlay = !inRecordingGap && showTelemetry && currentTelemFrame && isOverlayCam;
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
                style={{ visibility: inRecordingGap ? "hidden" : undefined }}
                onError={(e) => {
                  // Only report error if video has media loaded (ignore errors from clearing src)
                  if ((e.target as HTMLVideoElement).currentSrc) handleVideoError(cam);
                }}
                onEnded={() => handleEnded(cam)}
                onWaiting={() => handleWaiting(cam)}
                onPlaying={() => handlePlaying(cam)}
              />
              <span className="player-cam-label">{CAMERA_LABELS[cam]}</span>
              {bufferingCameras.has(cam) && !videoErrors.has(cam) && (
                <span className="player-video-buffering">Buffering...</span>
              )}
              {endedCameras.has(cam) && !videoErrors.has(cam) && (
                <span className="player-video-ended">End of clip</span>
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
        {inRecordingGap && <div className="player-loading-overlay" role="status">No archived video for this interval. Use Next segment to continue.</div>}
      </div>

      {/* Transport controls */}
      <div className="player-controls">
        <button
          onClick={togglePlay}
          className="player-play-btn"
          disabled={allCamerasFailed}
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
          {formatTime(displayTime)} / {timeline.estimated ? "~" : ""}{formatTime(totalDuration)}
          {wallClockDisplay && (
            <span className="player-wall-clock" title="Recorded local time"> {wallClockDisplay}</span>
          )}
        </span>

        <div className="player-timeline-wrapper">
          <div
            ref={timelineRef}
            className={`player-timeline ${isZoomed ? "zoomed" : ""}`}
            role="slider"
            tabIndex={0}
            aria-label="Recording position"
            aria-valuemin={0}
            aria-valuemax={totalDuration}
            aria-valuenow={Math.min(displayTime, totalDuration)}
            aria-valuetext={`${formatTime(displayTime)} of ${timeline.estimated ? "approximately " : ""}${formatTime(totalDuration)}`}
            onKeyDown={(e) => {
              const target = e.key === "Home" ? 0 : e.key === "End" ? totalDuration : e.key === "ArrowLeft" || e.key === "ArrowDown" ? displayTimeRef.current - SEEK_STEP : e.key === "ArrowRight" || e.key === "ArrowUp" ? displayTimeRef.current + SEEK_STEP : null;
              if (target === null) return;
              e.preventDefault();
              e.stopPropagation();
              seekTo(target);
            }}
            onMouseMove={handleTimelineMouseMove}
            onMouseLeave={() => setHoverTime(null)}
            onClick={handleTimelineClick}
          >
            {event.clips.slice(0, -1).map((clip, i) => {
              const start = segmentOffsets[i] + timeline.durations[i];
              const end = segmentOffsets[i + 1];
              if (!completedSegments[i] || end <= start || end <= viewStart || start >= viewEnd) return null;
              return <span key={clip.timestamp} className="player-timeline-gap" title="No archived video" style={{ left: `${Math.max(0, timeToViewPct(start))}%`, width: `${Math.min(100, timeToViewPct(end)) - Math.max(0, timeToViewPct(start))}%` }} />;
            })}
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

        <label className="player-speed-group">
          Speed
          <select className="player-speed-select" aria-label="Playback speed" value={playbackRate} onChange={(e) => changeRate(Number(e.target.value))}>
            {SPEED_OPTIONS.map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}
