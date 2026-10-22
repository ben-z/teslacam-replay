import type { DashcamEvent, TelemetryData } from "./types";
import { HLS_CACHE_VERSION } from "./types";

const API_BASE = "/api";

export type EventPageType = DashcamEvent["type"];

export interface EventPage {
  type: EventPageType;
  events: DashcamEvent[];
  nextPageToken: string | null;
}

export async function fetchEventPage(
  type: EventPageType,
  pageToken: string | null,
  limit: number
): Promise<EventPage> {
  const params = new URLSearchParams({ type, limit: String(limit) });
  if (pageToken) params.set("pageToken", pageToken);
  const res = await fetch(`${API_BASE}/events/page?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch ${type} page: ${res.status}`);
  return res.json();
}

export async function fetchEvent(type: string, id: string, refresh: boolean): Promise<DashcamEvent> {
  const res = await fetch(`${API_BASE}/events/${type}/${id}${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch event: ${res.status}`);
  return res.json();
}

export function thumbnailUrl(type: string, id: string, version: string | undefined): string {
  return `${API_BASE}/events/${type}/${id}/thumbnail${version ? `?v=${version}` : ""}`;
}

export async function fetchTelemetry(
  type: string,
  eventId: string,
  segment: string
): Promise<TelemetryData | null> {
  const res = await fetch(`${API_BASE}/video/${type}/${eventId}/${segment}/telemetry`);
  if (!res.ok) throw new Error(`Vehicle data could not be loaded (HTTP ${res.status}).`);
  const data = await res.json();
  return data.hasSei ? data : null;
}

export function hlsManifestUrl(
  type: string,
  eventId: string,
  segment: string,
  camera: string
): string {
  return `${API_BASE}/hls/${type}/${eventId}/${segment}/${camera}/stream.m3u8?v=${HLS_CACHE_VERSION}`;
}
