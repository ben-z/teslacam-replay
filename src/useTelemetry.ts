import { useState, useRef, useEffect, useMemo } from "react";
import { fetchTelemetry } from "./api";
import type { DashcamEvent, TelemetryFrame, TelemetryData } from "./types";

interface UseTelemetryResult {
  frame: TelemetryFrame | null;
  loading: boolean;
}

export function useTelemetry(
  event: DashcamEvent,
  segmentIdx: number,
  displayTime: number,
  segmentOffsets: number[]
): UseTelemetryResult {
  const [data, setData] = useState<TelemetryData | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchIdRef = useRef(0);

  const segTimestamp = event.clips[segmentIdx]?.timestamp;

  useEffect(() => {
    if (!segTimestamp) {
      setData(null);
      setLoading(false);
      return;
    }

    const id = ++fetchIdRef.current;
    setData(null);
    setLoading(true);

    fetchTelemetry(event.type, event.id, segTimestamp).then(
      (result) => {
        if (fetchIdRef.current !== id) return;
        setData(result);
        setLoading(false);
      },
      () => {
        if (fetchIdRef.current !== id) return;
        setLoading(false);
      }
    );
  }, [event.type, event.id, segTimestamp]);

  // Binary search for the frame matching current playback position
  const frame = useMemo(() => {
    if (!data || data.frames.length === 0) return null;
    const segOff = segmentOffsets[segmentIdx] || 0;
    const localTimeMs = (displayTime - segOff) * 1000;
    let lo = 0, hi = data.frameTimesMs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (data.frameTimesMs[mid] <= localTimeMs) lo = mid;
      else hi = mid - 1;
    }
    return data.frames[lo];
  }, [data, displayTime, segmentIdx, segmentOffsets]);

  return { frame, loading };
}
