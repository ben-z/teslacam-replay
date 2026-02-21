import type { DashcamEvent } from "./types";

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

export function videoUrl(
  type: string,
  eventId: string,
  segment: string,
  camera: string
): string {
  return `${BASE}/video/${type}/${eventId}/${segment}/${camera}`;
}
