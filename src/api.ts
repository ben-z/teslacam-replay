import { assertArchiveCatalog, assertArchiveDay, type ArchiveCatalog, type ArchiveDay, type ArchiveDayKey, type RecordingType } from "./archive";
import type { DashcamEvent, TelemetryData } from "./types";
import { HLS_CACHE_VERSION } from "./types";

const API_BASE = "/api";

export async function fetchArchiveCatalog(type: RecordingType): Promise<ArchiveCatalog> {
  const res = await fetch(`${API_BASE}/archive/${type}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Recording dates could not be checked (HTTP ${res.status}).`);
  const catalog: unknown = await res.json();
  assertArchiveCatalog(catalog);
  if (catalog.type !== type) throw new Error(`Expected ${type} recording dates, received ${catalog.type}.`);
  return catalog;
}

export async function fetchArchiveDay({ type, date }: ArchiveDayKey): Promise<ArchiveDay> {
  const res = await fetch(`${API_BASE}/archive/${type}/${date}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Recordings for ${date} could not be loaded (HTTP ${res.status}).`);
  const day: unknown = await res.json();
  assertArchiveDay(day);
  if (day.type !== type || day.date !== date) throw new Error(`Expected ${type}/${date} recordings, received ${day.type}/${day.date}.`);
  return day;
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
