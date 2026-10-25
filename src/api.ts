import type { DashcamEvent, TelemetryData } from "./types";
import { HLS_CACHE_VERSION } from "./types";

const API_BASE = "/api";

export type EventPageType = DashcamEvent["type"];
export const EVENT_PAGE_TYPES: EventPageType[] = ["SavedClips", "SentryClips", "RecentClips"];

export interface EventPagePosition {
  nextPageToken: string | null;
  nextPageDate: string | null;
}

export type EventPagePositions = Partial<Record<EventPageType, EventPagePosition>>;

export interface EventPage extends EventPagePosition {
  type: EventPageType;
  events: DashcamEvent[];
}
export async function fetchEventPage(
  type: EventPageType,
  pageToken: string | null,
  limit: number
): Promise<EventPage> {
  const params = new URLSearchParams({ type, limit: String(limit) });
  if (pageToken) params.set("pageToken", pageToken);
  const res = await fetch(`${API_BASE}/events/page?${params.toString()}`);
  if (!res.ok) throw new Error(`Recordings could not be loaded (HTTP ${res.status}).`);
  const page: EventPage = await res.json();
  if (page.type !== type) throw new Error(`Expected ${type} recordings, received ${page.type}.`);
  if (page.nextPageToken !== null && (typeof page.nextPageToken !== "string" || !page.nextPageToken)) {
    throw new Error("Invalid recording page token.");
  }
  if (page.nextPageDate !== null && (
    typeof page.nextPageDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(page.nextPageDate) ||
    !Number.isFinite(Date.parse(`${page.nextPageDate}T00:00:00Z`)) ||
    new Date(`${page.nextPageDate}T00:00:00Z`).toISOString().slice(0, 10) !== page.nextPageDate
  )) throw new Error("Invalid recording page date.");
  if (page.nextPageToken === null && page.nextPageDate !== null) {
    throw new Error("An exhausted recording source cannot have an older-page date.");
  }
  return page;
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
