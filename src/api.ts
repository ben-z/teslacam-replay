import type { DashcamEvent, TelemetryData } from "./types";

const STORAGE_KEY = "teslacam-replay:api-url";

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

export type ServerStatus =
  | { connected: false; setupStep: "oauth" | "folder" }
  | {
      connected: true;
      storageBackend: string;
      storagePath: string;
      eventCount: number | null;
      scanning: boolean;
    };

export async function fetchStatus(): Promise<ServerStatus> {
  const res = await fetch(`${API_BASE}/status`);
  if (!res.ok) throw new Error(`Failed to fetch status: ${res.status}`);
  return res.json();
}

export async function fetchOAuthStartUrl(): Promise<string> {
  const res = await fetch(`${API_BASE}/oauth/start`);
  if (!res.ok) throw new Error(`Failed to start OAuth: ${res.status}`);
  const data = await res.json();
  return data.url;
}

export async function submitFolderUrl(folderUrl: string): Promise<void> {
  const res = await fetch(`${API_BASE}/oauth/select-folder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderUrl }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error(data.error || `Failed to select folder: ${res.status}`);
  }
}

export interface CacheInfo {
  id: string;
  label: string;
  path: string | null;
  sizeBytes?: number;
  entryCount?: number;
}

export async function fetchCaches(): Promise<CacheInfo[]> {
  const res = await fetch(`${API_BASE}/debug/caches`);
  if (!res.ok) throw new Error(`Failed to fetch caches: ${res.status}`);
  const data = await res.json();
  return data.caches;
}

export async function clearCache(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/debug/caches/${id}/clear`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to clear cache: ${res.status}`);
}

export function hlsManifestUrl(
  type: string,
  eventId: string,
  segment: string,
  camera: string
): string {
  return `${API_BASE}/hls/${type}/${eventId}/${segment}/${camera}/stream.m3u8`;
}
