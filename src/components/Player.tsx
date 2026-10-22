import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import Hls, { type FragBufferedData } from "hls.js";
import { hlsManifestUrl } from "../api";
import type { DashcamEvent, CameraAngle } from "../types";
import { ALL_CAMERAS, CAMERA_LABELS, formatReason } from "../types";
import { useTelemetry } from "../useTelemetry";
import { TelemetryOverlay } from "./TelemetryOverlay";
import { hasReachedPlaybackEnd, playbackBoundary, playbackParticipants, playbackTimeline, recordingWallTimeMs, type CompletedDurations } from "../playback";
import "./Player.css";

interface Props {
  event: DashcamEvent;
  onBack: () => void;
  onRefresh: () => void;
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

function cameraSeekTime(time: number, completedDuration: number | undefined): number {
  const nonnegative = Math.max(0, time);
  return completedDuration === undefined ? nonnegative : Math.min(nonnegative, completedDuration);
}

const SYNC_THRESHOLD = 0.15; // seconds - max drift before re-syncing
const SYNC_INTERVAL = 200; // ms - how often to check sync
const SEEK_STEP = 5; // seconds for arrow key seeking
const SPEED_OPTIONS = [0.5, 1, 1.5, 2];
const NEXT_SEGMENT_PREFETCH_WINDOW = 15; // seconds before boundary
const HLS_LOAD_TIMEOUT_MS = 120_000; // first-run server-side segmentation can take tens of seconds
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

export function Player({ event, onBack, onRefresh, onNavigate, hasPrev, hasNext }: Props) {
  const [layout, setLayout] = useState<Layout>("focus");
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
  const [showTelemetry, setShowTelemetry] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const eventKey = `${event.type}/${event.id}`;
  const [completedDurationState, setCompletedDurationState] = useState<{ eventKey: string; durations: CompletedDurations }>({ eventKey, durations: {} });
  const completedDurations = completedDurationState.eventKey === eventKey ? completedDurationState.durations : {};
  const completedDurationsRef = useRef(completedDurations);
  completedDurationsRef.current = completedDurations;
  const pendingFinalSeekRef = useRef<{ eventKey: string; timestamp: string; time: number; cameras: CameraAngle[]; layout: Layout; focusCamera: CameraAngle } | null>(null);
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
  const segmentLoadingRef = useRef(false);
  const canplayCleanupRef = useRef<(() => void) | null>(null);
  const segmentOffsetsRef = useRef<number[]>([0]);
  const bufferingCamerasRef = useRef<Set<CameraAngle>>(new Set());
  const videoErrorsRef = useRef<Set<CameraAngle>>(new Set());
  const endedCamerasRef = useRef<Set<CameraAngle>>(new Set());
  const prefetchedSegmentsRef = useRef<Set<string>>(new Set());

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

  const participantCameras = playbackParticipants(activeCameras, layout === "focus" ? focusCamera : null);
  const selectedCameraMissing = layout === "focus" && Boolean(segment && !segment.cameras.includes(focusCamera));
  const participantDuration = segment
    ? playbackBoundary(0, null, participantCameras.map((camera) => completedDurations[segment.timestamp]?.[camera]))
    : null;
  const inRecordingGap = Boolean(segment && participantDuration !== null && segmentIdx < event.clips.length - 1 && displayTime >= segmentOffsets[segmentIdx] + participantDuration && displayTime < segmentOffsets[segmentIdx + 1]);
  const participantCamerasRef = useRef<CameraAngle[]>([]);
  participantCamerasRef.current = participantCameras;
  const selectionRef = useRef({ layout, focusCamera });
  selectionRef.current = { layout, focusCamera };
  const loadedParticipantsRef = useRef("");
  const allCamerasFailed = participantCameras.length > 0 && participantCameras.every((camera) => videoErrors.has(camera));
  const audioAvailable = participantCameras.includes("front");
  const { frame: currentTelemFrame, loading: telemetryLoading, error: telemetryError, available: telemetryAvailable } =
    useTelemetry(event, showTelemetry && participantCameras.length > 0 ? segmentIdx : -1, displayTime, segmentOffsets);

  const setRef = useCallback(
    (camera: CameraAngle, el: HTMLVideoElement | null) => {
      if (el) videoElsRef.current.set(camera, el);
      else videoElsRef.current.delete(camera);
    },
    []
  );

  // --- HLS helpers ---

  const clearBuffering = useCallback((cam: CameraAngle) => {
    setBufferingCameras((previous) => {
      if (!previous.has(cam)) return previous;
      const next = new Set(previous);
      next.delete(cam);
      return next;
    });
  }, []);

  const handleMediaReady = useCallback((cam: CameraAngle) => {
    const video = videoElsRef.current.get(cam);
    const source = hlsSourcesRef.current.get(cam);
    const hls = hlsInstancesRef.current.get(cam);
    if (!participantCamerasRef.current.includes(cam) || !video || video.readyState < 2 || !source || source.eventKey !== eventKeyRef.current) return;
    if (hls ? hls.latestLevelDetails?.url !== source.url : video.src !== source.url) return;
    clearBuffering(cam);
  }, [clearBuffering]);

  const handleVideoError = useCallback((cam: CameraAngle) => {
    if (!participantCamerasRef.current.includes(cam)) return;
    if (pendingFinalSeekRef.current?.cameras.includes(cam)) pendingFinalSeekRef.current = null;
    const errors = new Set(videoErrorsRef.current);
    errors.add(cam);
    clearBuffering(cam);
    videoErrorsRef.current = errors;
    setVideoErrors(errors);
    // Destroy HLS instance on fatal error — HLS.js can't recover in-place.
    // attachHls will create a fresh instance when the camera is retried.
    const hls = hlsInstancesRef.current.get(cam);
    if (hls) { hls.destroy(); hlsInstancesRef.current.delete(cam); }
    if (participantCamerasRef.current.length > 0 && participantCamerasRef.current.every((camera) => errors.has(camera))) {
      canplayCleanupRef.current?.();
      canplayCleanupRef.current = null;
      segmentLoadingRef.current = false;
      setSegmentLoading(false);
      isPlayingRef.current = false;
      setIsPlaying(false);
      videoElsRef.current.forEach((video) => video.pause());
    }
  }, [clearBuffering]);

  const playCamera = useCallback((camera: CameraAngle, video: HTMLVideoElement) => {
    if (!participantCamerasRef.current.includes(camera) || videoErrorsRef.current.has(camera)) return;
    const source = hlsSourcesRef.current.get(camera);
    const localTime = displayTimeRef.current - segmentOffsetsRef.current[segmentIdxRef.current];
    const duration = source && completedDurationsRef.current[source.timestamp]?.[camera];
    if (duration !== undefined && localTime >= duration) {
      video.pause();
      const boundary = playbackBoundary(0, null, participantCamerasRef.current.filter((cam) => !videoErrorsRef.current.has(cam)).map((cam) => source && completedDurationsRef.current[source.timestamp]?.[cam]));
      if (segmentIdxRef.current === segmentOffsetsRef.current.length - 2 && boundary !== null && localTime >= boundary) {
        isPlayingRef.current = false;
        setIsPlaying(false);
      }
      return;
    }
    video.play().catch((error: unknown) => {
      // Pausing or replacing a source intentionally cancels its pending play.
      if (!isPlayingRef.current || !participantCamerasRef.current.includes(camera) || hlsSourcesRef.current.get(camera) !== source) return;
      isPlayingRef.current = false;
      setIsPlaying(false);
      videoElsRef.current.forEach((element) => element.pause());
      setPlayerError(`Playback could not start: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, []);

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

  const attachHls = useCallback((cam: CameraAngle, url: string, timestamp: string, startPosition: number) => {
    const video = videoElsRef.current.get(cam);
    if (!video) return;
    hlsSourcesRef.current.set(cam, { url: new URL(url, location.href).href, eventKey: eventKeyRef.current, timestamp });

    const existing = hlsInstancesRef.current.get(cam);
    if (existing) {
      hlsInstancesRef.current.delete(cam);
      existing.destroy();
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        startPosition,
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
    if (segmentLoadingRef.current || !participantCamerasRef.current.includes(cam)) return;
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
    if (!participantCamerasRef.current.includes(cam) || videoErrorsRef.current.has(cam)) return;
    setBufferingCameras((prev) => {
      if (prev.has(cam)) return prev;
      const next = new Set(prev);
      next.add(cam);
      return next;
    });
  }, []);

  const handlePlaying = useCallback((cam: CameraAngle) => {
    handleMediaReady(cam);
    setEndedCameras((prev) => {
      if (!prev.has(cam)) return prev;
      const next = new Set(prev);
      next.delete(cam);
      return next;
    });
  }, [handleMediaReady]);

  // --- Retry ---

  const retryCamera = useCallback((cam: CameraAngle) => {
    const seg = event.clips[segmentIdxRef.current];
    if (!seg || !participantCamerasRef.current.includes(cam)) return;

    const errors = new Set(videoErrorsRef.current);
    errors.delete(cam);
    videoErrorsRef.current = errors;
    setVideoErrors(errors);

    const localTime = displayTimeRef.current - segmentOffsetsRef.current[segmentIdxRef.current];
    handleWaiting(cam);
    const seekTime = cameraSeekTime(localTime, completedDurationsRef.current[seg.timestamp]?.[cam]);
    attachHls(cam, hlsManifestUrl(event.type, event.id, seg.timestamp, cam), seg.timestamp, seekTime);

    // Sync to current displayTime
    const v = videoElsRef.current.get(cam);
    if (v) {
      v.currentTime = seekTime;
      v.playbackRate = playbackRateRef.current;
      if (isPlayingRef.current) playCamera(cam, v);
    }
  }, [event.clips, event.type, event.id, attachHls, playCamera, handleWaiting]);

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
      const active = participantCamerasRef.current;
      const errors = videoErrorsRef.current;
      const buffering = bufferingCamerasRef.current;
      const playable = active.filter((cam) => !errors.has(cam));
      if (isPlayingRef.current && active.length > 0 && playable.length === 0) {
        isPlayingRef.current = false;
        setIsPlaying(false);
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
        displayTimeRef.current = Math.max(displayTimeRef.current, actualEnd);
        setDisplayTime(displayTimeRef.current);
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
          const source = hlsSourcesRef.current.get(cam);
          v.currentTime = cameraSeekTime(expectedLocal, source && completedDurationsRef.current[source.timestamp]?.[cam]);
        }
      }

      // 3. Auto-advance at segment boundary
      if (isPlayingRef.current) {
        if (nextStart !== null && boundary !== null && displayTimeRef.current >= boundary) {
          advanceSegmentRef.current();
        }
      }
    }, SYNC_INTERVAL);
    return () => clearInterval(syncIntervalRef.current);
  }, []);

  // Loading a new segment resets its errors. Changing the displayed cameras
  // preserves the current segment, source metadata, and recording position.
  const loadSegment = useCallback(
    (idx: number, seekTime: number, newSegment: boolean) => {
      const seg = event.clips[idx];
      if (!seg) return;
      const available = allEventCameras.filter((camera) => seg.cameras.includes(camera));
      const selection = selectionRef.current;
      const participants = playbackParticipants(available, selection.layout === "focus" ? selection.focusCamera : null);
      participantCamerasRef.current = participants;
      loadedParticipantsRef.current = `${eventKey}/${seg.timestamp}/${participants.join(",")}`;

      canplayCleanupRef.current?.();
      canplayCleanupRef.current = null;
      if (newSegment) {
        videoErrorsRef.current = new Set();
        setVideoErrors(videoErrorsRef.current);
      }
      bufferingCamerasRef.current = new Set(participants.filter((camera) => !videoErrorsRef.current.has(camera)));
      setBufferingCameras(bufferingCamerasRef.current);
      setEndedCameras(new Set());
      setPlayerError(null);
      setSegmentLoading(true);
      segmentLoadingRef.current = true;
      const targetGlobalTime = segmentOffsetsRef.current[idx] + seekTime;
      setDisplayTime(targetGlobalTime);
      displayTimeRef.current = targetGlobalTime;

      for (const [camera, video] of videoElsRef.current) {
        if (participants.includes(camera)) continue;
        video.pause();
        const hls = hlsInstancesRef.current.get(camera);
        if (hls) {
          hls.destroy();
          hlsInstancesRef.current.delete(camera);
        }
        if (video.hasAttribute("src")) {
          video.removeAttribute("src");
          video.load();
        }
      }

      const playable = participants.filter((camera) => !videoErrorsRef.current.has(camera));
      if (playable.length === 0) {
        segmentLoadingRef.current = false;
        setSegmentLoading(false);
        isPlayingRef.current = false;
        setIsPlaying(false);
        return;
      }

      let readyFired = false;
      const cleanups: (() => void)[] = [];
      const onReady = () => {
        if (readyFired) return;
        readyFired = true;
        cleanups.forEach((cleanup) => cleanup());
        canplayCleanupRef.current = null;
        setSegmentLoading(false);
        segmentLoadingRef.current = false;
        const localTime = displayTimeRef.current - segmentOffsetsRef.current[idx];
        for (const camera of playable) {
          const video = videoElsRef.current.get(camera);
          if (!video || !participantCamerasRef.current.includes(camera)) continue;
          const completedDuration = completedDurationsRef.current[seg.timestamp]?.[camera];
          video.currentTime = cameraSeekTime(localTime, completedDuration);
          video.playbackRate = playbackRateRef.current;
          if (isPlayingRef.current) playCamera(camera, video);
        }
      };

      let bufferedAtPosition = false;
      for (const camera of playable) {
        const video = videoElsRef.current.get(camera);
        if (!video) continue;
        const source = hlsSourcesRef.current.get(camera);
        const sameSource = source?.eventKey === eventKey && source.timestamp === seg.timestamp;
        const cameraTime = cameraSeekTime(seekTime, completedDurationsRef.current[seg.timestamp]?.[camera]);
        const existing = hlsInstancesRef.current.get(camera);
        if (!sameSource || (!existing && !video.hasAttribute("src"))) {
          attachHls(camera, hlsManifestUrl(event.type, event.id, seg.timestamp, camera), seg.timestamp, cameraTime);
        }
        const hls = hlsInstancesRef.current.get(camera);
        const expectedSource = hlsSourcesRef.current.get(camera);
        if (hls) {
          const handler = (_event: string, data: FragBufferedData) => {
            if (hlsSourcesRef.current.get(camera) !== expectedSource || data.frag.baseurl !== expectedSource?.url) return;
            onReady();
          };
          hls.on(Hls.Events.FRAG_BUFFERED, handler);
          cleanups.push(() => hls.off(Hls.Events.FRAG_BUFFERED, handler));
        }
        if (!hls || sameSource) {
          const readyHandler = () => {
            if (hlsSourcesRef.current.get(camera) !== expectedSource || video.readyState < 3) return;
            if (hls && hls.latestLevelDetails?.url !== expectedSource?.url) return;
            onReady();
          };
          video.addEventListener("canplay", readyHandler);
          cleanups.push(() => video.removeEventListener("canplay", readyHandler));
        }
        video.currentTime = cameraTime;
        video.playbackRate = playbackRateRef.current;
        if (sameSource && (!hls || hls.latestLevelDetails?.url === expectedSource?.url) && video.readyState >= 2) {
          clearBuffering(camera);
          for (let range = 0; range < video.buffered.length; range++) {
            if (video.buffered.start(range) <= cameraTime && video.buffered.end(range) >= cameraTime) {
              if (video.readyState >= 3) bufferedAtPosition = true;
              break;
            }
          }
        }
      }
      canplayCleanupRef.current = () => cleanups.forEach((cleanup) => cleanup());
      if (bufferedAtPosition) onReady();
    },
    [event.clips, event.type, event.id, eventKey, allEventCameras, attachHls, playCamera, clearBuffering]
  );

  // Advance to next segment
  const advanceSegment = useCallback(() => {
    const nextIdx = segmentIdxRef.current + 1;
    if (nextIdx >= event.clips.length) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      videoElsRef.current.forEach((video) => video.pause());
      return;
    }
    segmentIdxRef.current = nextIdx;
    setSegmentIdx(nextIdx);
    loadSegment(nextIdx, 0, true);
  }, [event.clips.length, loadSegment]);
  advanceSegmentRef.current = advanceSegment;

  // Seek to global time
  const seekTo = useCallback(
    (globalTime: number) => {
      const offsets = segmentOffsetsRef.current;
      const requested = Math.max(0, Math.min(globalTime, totalDuration));
      // Find which segment this global time falls in
      let newSegIdx = 0;
      for (let i = event.clips.length - 1; i >= 0; i--) {
        if (requested >= offsets[i]) { newSegIdx = i; break; }
      }
      const target = event.clips[newSegIdx];
      const selection = selectionRef.current;
      const cameras = target ? playbackParticipants(target.cameras as CameraAngle[], selection.layout === "focus" ? selection.focusCamera : null).filter((camera) => newSegIdx !== segmentIdxRef.current || !videoErrorsRef.current.has(camera)) : [];
      const finalSeek = newSegIdx === event.clips.length - 1;
      const boundary = finalSeek && target ? playbackBoundary(offsets[newSegIdx], null, cameras.map((camera) => completedDurationsRef.current[target.timestamp]?.[camera])) : null;
      const clamped = boundary === null ? requested : Math.min(requested, boundary);
      pendingFinalSeekRef.current = finalSeek && boundary === null && cameras.length > 0
        ? { eventKey, timestamp: target.timestamp, time: requested, cameras, ...selection }
        : null;
      if (boundary !== null && clamped === boundary) {
        isPlayingRef.current = false;
        setIsPlaying(false);
        videoElsRef.current.forEach((video) => video.pause());
      }
      const localTime = clamped - offsets[newSegIdx];
      setDisplayTime(clamped);
      displayTimeRef.current = clamped;

      if (newSegIdx !== segmentIdxRef.current) {
        segmentIdxRef.current = newSegIdx;
        setSegmentIdx(newSegIdx);
        loadSegment(newSegIdx, localTime, true);
      } else {
        // Failed cameras remain available through their explicit Retry control.
        setEndedCameras(new Set());
        videoElsRef.current.forEach((v, cam) => {
          if (!participantCamerasRef.current.includes(cam) || videoErrorsRef.current.has(cam) || !v.currentSrc) return;
          v.currentTime = cameraSeekTime(localTime, completedDurationsRef.current[target.timestamp]?.[cam]);
          if (isPlayingRef.current) playCamera(cam, v);
        });
      }
    },
    [event.clips, eventKey, loadSegment, totalDuration, playCamera]
  );

  // An explicit seek can precede the final playlist becoming complete.
  useEffect(() => {
    const pending = pendingFinalSeekRef.current;
    if (!pending) return;
    if (pending.eventKey !== eventKey || pending.timestamp !== event.clips[segmentIdxRef.current]?.timestamp || pending.layout !== layout || pending.focusCamera !== focusCamera) {
      pendingFinalSeekRef.current = null;
      return;
    }
    const boundary = playbackBoundary(segmentOffsetsRef.current[segmentIdxRef.current], null, pending.cameras.map((camera) => completedDurations[pending.timestamp]?.[camera]));
    if (boundary === null) return;
    pendingFinalSeekRef.current = null;
    if (pending.time >= boundary) seekTo(boundary);
  }, [completedDurations, event.clips, eventKey, layout, focusCamera, seekTo]);

  // Play/Pause
  const togglePlay = useCallback(() => {
    if (participantCamerasRef.current.length === 0) return;
    if (isPlayingRef.current) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      videoElsRef.current.forEach((v) => v.pause());
    } else {
      setPlayerError(null);
      const atLastSegment = segmentIdxRef.current === event.clips.length - 1;
      const playable = participantCamerasRef.current.filter((camera) => !videoErrorsRef.current.has(camera));
      const segmentStart = segmentOffsetsRef.current[segmentIdxRef.current];
      const timestamp = event.clips[segmentIdxRef.current]?.timestamp;
      const completedEnd = playbackBoundary(segmentStart, null, playable.map((camera) => completedDurationsRef.current[timestamp]?.[camera]));
      const atAvailableEnd = hasReachedPlaybackEnd(playable.map((camera) => ({ ended: Boolean(videoElsRef.current.get(camera)?.ended) })))
        || (completedEnd !== null && displayTimeRef.current >= completedEnd);
      if (atLastSegment && atAvailableEnd) seekTo(0);
      isPlayingRef.current = true;
      setIsPlaying(true);
      videoElsRef.current.forEach((v, cam) => {
        if (!participantCamerasRef.current.includes(cam) || videoErrorsRef.current.has(cam) || !v.currentSrc) return;
        v.playbackRate = playbackRateRef.current;
        playCamera(cam, v);
      });
    }
  }, [event.clips, seekTo, playCamera]);

  useEffect(() => {
    if (finalDurationKnown && displayTimeRef.current > totalDuration) {
      displayTimeRef.current = totalDuration;
      setDisplayTime(totalDuration);
    }
  }, [finalDurationKnown, totalDuration]);

  const containerRef = useRef<HTMLDivElement>(null);

  // The browser can leave fullscreen through Escape or its own controls.
  useEffect(() => {
    const changed = () => setIsFullscreen(Boolean(document.fullscreenElement && document.fullscreenElement === containerRef.current));
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    setPlayerError(null);
    try {
      if (!document.fullscreenEnabled) throw new Error("This browser does not support fullscreen.");
      const container = containerRef.current;
      if (!container) throw new Error("The player is not available.");
      if (document.fullscreenElement === container) await document.exitFullscreen();
      else await container.requestFullscreen();
    } catch (error) {
      setPlayerError(`The browser could not change fullscreen: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  // Audio toggle (only front camera has audio)
  const toggleMute = useCallback(() => {
    if (!participantCamerasRef.current.includes("front")) return;
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

    const nextCameras = allEventCameras.filter((camera) => nextSegment.cameras.includes(camera));
    for (const cam of playbackParticipants(nextCameras, layout === "focus" ? focusCamera : null)) {
      const prefetchKey = `${event.type}/${event.id}/${nextSegment.timestamp}/${cam}`;
      if (prefetchedSegmentsRef.current.has(prefetchKey)) continue;
      prefetchedSegmentsRef.current.add(prefetchKey);
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
    layout,
    focusCamera,
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
    pendingFinalSeekRef.current = null;
    setCompletedDurationState({ eventKey, durations: {} });

    segmentIdxRef.current = 0;
    setSegmentIdx(0);
    setDisplayTime(0);
    displayTimeRef.current = 0;
    setVideoErrors(new Set());
    setBufferingCameras(new Set());
    setEndedCameras(new Set());
    prefetchedSegmentsRef.current.clear();
    const initialCamera = allEventCameras.find((camera) => event.clips[0]?.cameras.includes(camera));
    if (initialCamera !== undefined) {
      setFocusCamera(initialCamera);
      selectionRef.current = { ...selectionRef.current, focusCamera: initialCamera };
    }

    loadSegment(0, 0, true);
  }, [eventKey, loadSegment]);

  // A layout/camera change reconciles sources without resetting playback.
  useEffect(() => {
    pendingFinalSeekRef.current = null;
    const seg = event.clips[segmentIdxRef.current];
    if (!seg) return;
    const key = `${eventKey}/${seg.timestamp}/${participantCamerasRef.current.join(",")}`;
    if (key === loadedParticipantsRef.current) return;
    loadSegment(segmentIdxRef.current, displayTimeRef.current - segmentOffsetsRef.current[segmentIdxRef.current], false);
  }, [layout, focusCamera, event.clips, eventKey, loadSegment]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
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
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      if (showShortcuts) {
        if (e.key === "Escape") setShowShortcuts(false);
        return;
      }
      if (e.altKey || e.ctrlKey || e.metaKey || t.closest("input, textarea, select") || t.isContentEditable) return;
      if (t.closest("button, a") && (e.key === " " || e.key === "Enter")) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (e.shiftKey) {
            // Shift+Left: jump to previous segment
            if (segmentIdxRef.current > 0) {
              seekTo(segmentOffsetsRef.current[segmentIdxRef.current - 1]);
            }
          } else {
            seekTo(displayTimeRef.current - SEEK_STEP);
          }
          break;
        case "ArrowRight":
          e.preventDefault();
          if (e.shiftKey) {
            // Shift+Right: jump to next segment
            if (segmentIdxRef.current < segmentOffsetsRef.current.length - 2) {
              seekTo(segmentOffsetsRef.current[segmentIdxRef.current + 1]);
            }
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
          if (document.fullscreenElement && document.fullscreenElement === containerRef.current) {
            e.preventDefault();
            void toggleFullscreen();
          } else onBack();
          break;
        case "?":
          if (allEventCameras.length > 0) setShowShortcuts((s) => !s);
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
  }, [togglePlay, seekTo, onBack, onNavigate, hasPrev, hasNext, toggleMute, allEventCameras, showShortcuts, toggleFullscreen]);

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
    return isActive && cam === focusCamera
      ? { gridColumn: 1, gridRow: 1 }
      : { display: "none" };
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
      {onNavigate && (hasPrev || hasNext) && (
        <div className="player-recording-nav" role="group" aria-label="Recording navigation">
          <span className="player-nav-label">Recordings</span>
          <button
            onClick={() => onNavigate(-1)}
            disabled={!hasPrev}
            className="player-nav-btn"
            title="Previous recording ([)"
            aria-label="Previous recording"
          >
            &lsaquo;
          </button>
          <button
            onClick={() => onNavigate(1)}
            disabled={!hasNext}
            className="player-nav-btn"
            title="Next recording (])"
            aria-label="Next recording"
          >
            &rsaquo;
          </button>
        </div>
      )}
      <button onClick={onRefresh} className="player-back-btn player-refresh-btn" aria-label="Refresh recording" title="Reload this recording's event details">Refresh</button>
    </div>
  );

  const header = (
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
          {event.city}
          <span className={event.city ? "player-header-date" : undefined} title="Recorded local time">
            {event.city && <> &middot; </>}
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

      {allEventCameras.length > 0 && (
        <div className="player-view-actions">
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
            className={`player-view-btn ${showTelemetry ? "active" : ""}`}
            aria-pressed={showTelemetry}
            title={`${showTelemetry ? "Hide" : "Show"} driving data (T)`}
            onClick={() => setShowTelemetry((visible) => !visible)}
          >
            Driving data
          </button>
          <button
            className={`player-view-btn ${isFullscreen ? "active" : ""}`}
            aria-label={document.fullscreenEnabled ? (isFullscreen ? "Exit fullscreen" : "Enter fullscreen") : "Fullscreen unavailable in this browser"}
            aria-pressed={isFullscreen}
            disabled={!document.fullscreenEnabled}
            title={document.fullscreenEnabled ? (isFullscreen ? "Exit fullscreen" : "Enter fullscreen") : "This browser does not support fullscreen"}
            onClick={toggleFullscreen}
          >
            Fullscreen
          </button>
        </div>
      )}
      {allEventCameras.length > 0 && layout === "focus" && (
        <label className="player-camera-picker">
          Camera
          <select className="player-camera-select" aria-label="Focused camera" value={focusCamera} onChange={(e) => setFocusCamera(e.target.value as CameraAngle)}>
            {allEventCameras.map((camera) => <option key={camera} value={camera}>{CAMERA_LABELS[camera]}</option>)}
          </select>
        </label>
      )}
      {allEventCameras.length > 0 && <button
        className="player-shortcuts-hint"
        onClick={() => setShowShortcuts((s) => !s)}
        aria-label="Keyboard shortcuts"
      >
        ?
      </button>}
    </header>
  );

  if (allEventCameras.length === 0) {
    return (
      <div className="player-container" ref={containerRef}>
        {header}
        <div className="player-empty">
          <h2>No archived video</h2>
          <p>This recording has no playable video files in the archive.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="player-container" ref={containerRef}>
      {/* Header */}
      {header}

      {showTelemetry && telemetryAvailable === false && <p className="player-media-status" role="status">No driving data in this clip.</p>}
      {telemetryError && <p className="player-media-status" role="alert">Driving data could not be loaded: {telemetryError}</p>}
      {playerError && <p className="player-media-status" role="alert">{playerError}</p>}
      {allCamerasFailed && (
        <p className="player-media-status" role="alert">{layout === "focus" ? "This camera failed to load. Retry it or choose another camera." : "All cameras failed to load for this segment. Retry a camera to try again."}</p>
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
                ["[ ]", "Previous / Next recording"],
                ["F", "Toggle grid / focus layout"],
                ["M", "Mute / Unmute"],
                ["T", "Toggle telemetry HUD"],
                ["1\u20136", "Switch camera"],
                ["Esc", "Exit fullscreen / Back to browse"],
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
      <div className={`player-videos player-videos-${layout}`}>
        {ALL_CAMERAS.map((cam, allIdx) => {
          const isActive = activeCameras.includes(cam);
          const video = videoElsRef.current.get(cam);
          const hls = hlsInstancesRef.current.get(cam);
          const source = hlsSourcesRef.current.get(cam);
          const completedDuration = segment && completedDurations[segment.timestamp]?.[cam];
          const atCompletedEnd = completedDuration !== undefined && displayTime >= segmentOffsets[segmentIdx] + completedDuration;
          const initialLoading = bufferingCameras.has(cam) && (!video || video.readyState < 2 || (hls && hls.latestLevelDetails?.url !== source?.url));
          const isFocused = cam === focusCamera && layout === "focus";
          const isOverlayCam = (layout === "focus" && cam === focusCamera) ||
            (layout === "grid" && cam === "front");
          const showOverlay = participantCameras.includes(cam) && !inRecordingGap && showTelemetry && currentTelemFrame && isOverlayCam;
          const showTelemLoading = participantCameras.includes(cam) && showTelemetry && telemetryLoading && !currentTelemFrame && isOverlayCam;
          return (
            <div
              key={cam}
              className={`player-video-cell ${isFocused ? "focused" : ""}`}
              style={getCellStyle(cam, allIdx, isActive)}
              onClick={() => {
                if (layout === "grid") {
                  setFocusCamera(cam);
                  setLayout("focus");
                } else if (cam !== focusCamera) {
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
                style={{ visibility: inRecordingGap || initialLoading ? "hidden" : undefined }}
                onError={(e) => {
                  // Only report error if video has media loaded (ignore errors from clearing src)
                  if ((e.target as HTMLVideoElement).currentSrc) handleVideoError(cam);
                }}
                onEnded={() => handleEnded(cam)}
                onWaiting={() => handleWaiting(cam)}
                onLoadedData={() => handleMediaReady(cam)}
                onCanPlay={() => handleMediaReady(cam)}
                onPlaying={() => handlePlaying(cam)}
              />
              <span className="player-cam-label">{CAMERA_LABELS[cam]}</span>
              {bufferingCameras.has(cam) && !videoErrors.has(cam) && (
                <span className="player-video-buffering" role="status">{initialLoading ? "Loading" : "Buffering"} {CAMERA_LABELS[cam]}...</span>
              )}
              {(endedCameras.has(cam) || atCompletedEnd) && !videoErrors.has(cam) && (
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
        {selectedCameraMissing && (
          <div className="player-loading-overlay" role="status">{CAMERA_LABELS[focusCamera]} camera has no recorded video in this segment. Choose another camera or segment.</div>
        )}
        {segmentLoading && (
          <div className="player-loading-overlay">Loading segment...</div>
        )}
        {inRecordingGap && <div className="player-loading-overlay" role="status">{layout === "focus" ? "This camera has no video for this interval. Choose another camera or use Next segment." : "No archived video for this interval. Use Next segment to continue."}</div>}
      </div>

      {/* Transport controls */}
      <div className="player-controls">
        <button
          onClick={togglePlay}
          className="player-play-btn"
          disabled={allCamerasFailed || participantCameras.length === 0}
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
          disabled={!audioAvailable}
          aria-label={audioAvailable ? (isMuted ? "Unmute" : "Mute") : "Audio is available only when the Front camera is active"}
          title={audioAvailable ? (isMuted ? "Unmute (M)" : "Mute (M)") : "Audio is available only when the Front camera is active"}
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
            title="Jump to event moment"
            aria-label="Jump to event moment"
          >
            Event
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
            aria-valuetext={`${formatTime(displayTime)} of ${timeline.estimated ? "approximately " : ""}${formatTime(totalDuration)}${segmentIdx === event.clips.length - 1 && participantDuration !== null && segmentOffsets[segmentIdx] + participantDuration < totalDuration ? `; ${layout === "focus" ? CAMERA_LABELS[focusCamera] : "Selected"} footage ends at ${formatTime(segmentOffsets[segmentIdx] + participantDuration)}` : ""}`}
            onKeyDown={(e) => {
              if (e.altKey || e.ctrlKey || e.metaKey || (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight"))) return;
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
                title="Event moment"
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

        {event.clips.length > 1 && <div className="player-segment-group" role="group" aria-label="Segment navigation">
          <span className="player-nav-label">Clips</span>
          <button
            className="player-segment-btn"
            disabled={segmentIdx === 0}
            onClick={() => seekTo(segmentOffsetsRef.current[segmentIdx - 1])}
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
            onClick={() => seekTo(segmentOffsetsRef.current[segmentIdx + 1])}
            title="Next segment (Shift+Right)"
            aria-label="Next segment"
          >
            &rsaquo;
          </button>
        </div>}

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
