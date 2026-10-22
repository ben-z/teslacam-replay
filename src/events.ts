import type { DashcamEvent } from "./types";

export function mergeRecentFragments<T extends DashcamEvent>(
  existing: T[],
  incoming: T,
  merge: (first: T, later: T) => T,
): { events: T[]; merged: T; originalIds: string[] } {
  if (incoming.type !== "RecentClips") throw new Error("Only Recent recording fragments can be combined");
  const timestamps = new Set(incoming.clips.map((clip) => clip.timestamp));
  const originalIds = new Set([incoming.id]);
  const overlaps = new Set<number>();
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const [index, event] of existing.entries()) {
      if (event.type !== "RecentClips" || overlaps.has(index)) continue;
      if (!originalIds.has(event.id) && !event.clips.some((clip) => timestamps.has(clip.timestamp))) continue;
      overlaps.add(index);
      originalIds.add(event.id);
      for (const clip of event.clips) timestamps.add(clip.timestamp);
      expanded = true;
    }
  }
  if (overlaps.size === 0) return { events: [...existing, incoming], merged: incoming, originalIds: [incoming.id] };
  const indices = [...overlaps].sort((a, b) => a - b);
  const firstIndex = indices[0];
  let merged = existing[firstIndex];
  for (const index of indices.slice(1)) merged = merge(merged, existing[index]);
  merged = merge(merged, incoming);
  if (merged.id !== existing[firstIndex].id) throw new Error("Recent fragment merge must retain its first loaded recording ID");
  return {
    events: existing.flatMap((event, index) => index === firstIndex ? [merged] : overlaps.has(index) ? [] : [event]),
    merged,
    originalIds: [...originalIds],
  };
}

function mergeRecentCameras(existing: DashcamEvent, incoming: DashcamEvent): DashcamEvent {
  const clips = new Map(existing.clips.map((clip) => [clip.timestamp, clip]));
  for (const clip of incoming.clips) {
    const previous = clips.get(clip.timestamp);
    clips.set(clip.timestamp, previous ? {
      ...previous,
      ...clip,
      cameras: [...new Set([...previous.cameras, ...clip.cameras])],
      durationSec: Math.max(previous.durationSec, clip.durationSec),
    } : clip);
  }
  const mergedClips = [...clips.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return {
    ...existing,
    ...incoming,
    id: existing.id,
    timestamp: mergedClips[0].timestamp.replace("_", "T").replace(/-(\d{2})-(\d{2})$/, ":$1:$2"),
    clips: mergedClips,
    totalDurationSec: mergedClips.reduce((sum, clip) => sum + clip.durationSec, 0),
    cameraCount: new Set(mergedClips.flatMap((clip) => clip.cameras)).size,
  };
}

/** State retains load order; views choose their chronological presentation. */
export function mergeEvents(existing: DashcamEvent[], incoming: DashcamEvent[]): DashcamEvent[] {
  let events = [...existing];
  for (const event of incoming) {
    if (event.type === "RecentClips") {
      const result = mergeRecentFragments(events, event, mergeRecentCameras);
      // Server load order is shared across browsers and owns the public recording ID.
      events = result.events.map((entry) => entry === result.merged ? { ...entry, id: event.id } : entry);
      continue;
    }
    const index = events.findIndex((previous) => previous.type === event.type && previous.id === event.id);
    if (index < 0) events.push(event);
    else events[index] = event;
  }
  return events;
}

/** A refreshed recording replaces its loaded scope, including removed cameras. */
export function replaceEventSnapshot(existing: DashcamEvent[], incoming: DashcamEvent): DashcamEvent[] {
  if (incoming.type !== "RecentClips") return mergeEvents(existing, [incoming]);
  const result = mergeRecentFragments(existing, incoming, (first, snapshot) => ({ ...snapshot, id: first.id }));
  return result.events.map((entry) => entry === result.merged ? { ...entry, id: incoming.id } : entry);
}
