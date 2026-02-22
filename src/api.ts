import type { DashcamEvent, TelemetryData } from "./types";

const STORAGE_KEY = "dashreplay:api-url";

function initApiBase(): string {
  const params = new URLSearchParams(window.location.search);
  const serverParam = params.get("server");
  if (serverParam) {
    // Normalize: strip trailing slash, ensure /api suffix
    const base = serverParam.replace(/\/+$/, "");
    const url = base.endsWith("/api") ? base : `${base}/api`;
    localStorage.setItem(STORAGE_KEY, url);
    // Remove ?server= from URL to keep it clean
    params.delete("server");
    const clean = params.toString();
    const newUrl = window.location.pathname + (clean ? `?${clean}` : "") + window.location.hash;
    window.history.replaceState(null, "", newUrl);
    return url;
  }
  return localStorage.getItem(STORAGE_KEY) || "/api";
}

const API_BASE = initApiBase();

export function getApiBase(): string {
  return API_BASE;
}

export async function fetchEvents(): Promise<DashcamEvent[]> {
  const res = await fetch(`${API_BASE}/events`);
  if (!res.ok) throw new Error(`Failed to fetch events: ${res.status}`);
  return res.json();
}

export async function refreshEvents(): Promise<DashcamEvent[]> {
  const res = await fetch(`${API_BASE}/refresh`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to refresh: ${res.status}`);
  return res.json();
}

export function thumbnailUrl(type: string, id: string): string {
  return `${API_BASE}/events/${type}/${id}/thumbnail`;
}

export async function fetchTelemetry(
  type: string,
  eventId: string,
  segment: string
): Promise<TelemetryData | null> {
  try {
    const res = await fetch(`${API_BASE}/video/${type}/${eventId}/${segment}/telemetry`);
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
  return `${API_BASE}/hls/${type}/${eventId}/${segment}/${camera}/stream.m3u8`;
}
