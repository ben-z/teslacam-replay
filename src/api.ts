import type { DashcamEvent, TelemetryData } from "./types";

const BASE = "/api";

export async function fetchEvents(): Promise<DashcamEvent[]> {
  const res = await fetch(`${BASE}/events`);
  if (!res.ok) throw new Error(`Failed to fetch events: ${res.status}`);
  return res.json();
}

export async function refreshEvents(): Promise<DashcamEvent[]> {
  const res = await fetch(`${BASE}/refresh`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to refresh: ${res.status}`);
  return res.json();
}

export function thumbnailUrl(type: string, id: string): string {
  return `${BASE}/events/${type}/${id}/thumbnail`;
}

export async function fetchTelemetry(
  type: string,
  eventId: string,
  segment: string
): Promise<TelemetryData | null> {
  try {
    const res = await fetch(`${BASE}/video/${type}/${eventId}/${segment}/telemetry`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.hasSei ? data : null;
  } catch {
    return null;
  }
}

export function hlsManifestUrl(
  type: string,
  eventId: string,
  segment: string,
  camera: string
): string {
  return `${BASE}/hls/${type}/${eventId}/${segment}/${camera}/stream.m3u8`;
}
