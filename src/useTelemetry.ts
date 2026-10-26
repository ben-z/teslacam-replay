import { useState, useEffect, useMemo } from "react";
import { fetchTelemetry } from "./api";
import type { DashcamEvent, TelemetryFrame, TelemetryData } from "./types";
import { telemetryFrameAt } from "./telemetry";

interface UseTelemetryResult {
  frame: TelemetryFrame | null;
  data: TelemetryData | null;
  loading: boolean;
  error: string | null;
  available: boolean | null;
}

export function useTelemetry(
  event: DashcamEvent,
  segmentIdx: number,
  displayTime: number,
  segmentOffsets: number[]
): UseTelemetryResult {
  const segTimestamp = event.clips[segmentIdx]?.timestamp;
  const [result, setResult] = useState<{
    event: DashcamEvent;
    segment: string;
    data: TelemetryData | null;
    error: string | null;
  } | null>(null);
  const current = result?.event === event && result.segment === segTimestamp ? result : null;
  const data = current?.data;

  useEffect(() => {
    if (!segTimestamp) return;
    let active = true;

    fetchTelemetry(event.type, event.id, segTimestamp).then(
      (result) => {
        if (active) setResult({ event, segment: segTimestamp, data: result, error: null });
      },
      (error: unknown) => {
        if (active) setResult({ event, segment: segTimestamp, data: null, error: error instanceof Error ? error.message : String(error) });
      }
    );
    return () => { active = false; };
  }, [event, segTimestamp]);

  // Binary search for the frame matching current playback position
  const frame = useMemo(() => {
    if (!data) return null;
    const segOff = segmentOffsets[segmentIdx];
    const localTimeMs = (displayTime - segOff) * 1000;
    return telemetryFrameAt(data, localTimeMs);
  }, [data, displayTime, segmentIdx, segmentOffsets]);

  return {
    frame,
    data: data ?? null,
    loading: Boolean(segTimestamp) && current === null,
    error: current?.error ?? null,
    available: current === null || current.error !== null ? null : current.data !== null,
  };
}
