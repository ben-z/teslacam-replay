import { recordingWallTimeMs } from "../playback";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import type { DashcamEvent } from "../types";
import { EventBrowser } from "./EventBrowser";
import { RECORDING_TYPES, archiveDayKey } from "../archive";
import { catalogKey, type ArchiveState } from "../recordingArchive";

function snapshot(events: DashcamEvent[], changes: Partial<ArchiveState>): ArchiveState {
  return {
    restored: true, pending: new Set(), errors: {}, cacheError: null, details: [],
    catalogs: Object.fromEntries(RECORDING_TYPES.map((type) => [type, { type, dates: events.some((event) => event.type === type) ? ["2026-10-22"] : [] }])),
    days: Object.fromEntries(RECORDING_TYPES.filter((type) => events.some((event) => event.type === type)).map((type) => [archiveDayKey({ type, date: "2026-10-22" }), { type, date: "2026-10-22", events: events.filter((event) => event.type === type) }])),
    ...changes,
  };
}

function render(events: DashcamEvent[], overrides: Partial<ComponentProps<typeof EventBrowser>> = {}) {
  return renderToStaticMarkup(<EventBrowser
    active={true}
    events={events}
    archive={snapshot(events, {})}
    onSelectEvent={() => {}}
    onRefresh={() => {}}
    onLoadCatalog={() => {}}
    onLoadDays={() => {}}
    {...overrides}
  />);
}

function recording(type: DashcamEvent["type"]): DashcamEvent {
  return {
    id: "2026-10-22_12-00-00",
    type,
    timestamp: "2026-10-22T12:00:00",
    hasThumbnail: false,
    clips: type === "RecentClips" ? [{ timestamp: "2026-10-22_12-00-00", captureTimeMs: recordingWallTimeMs("2026-10-22_12-00-00"), cameras: ["front"], durationSec: 60 }] : [],
    totalDurationSec: type === "RecentClips" ? 60 : 0,
  };
}

describe("recording list archive scope", () => {
  it("loads advertised previews lazily only while browsing is active", () => {
    const event = { ...recording("RecentClips"), hasThumbnail: true, thumbnailVersion: "preview-version" };
    expect(render([event])).toContain('loading="lazy"');
    expect(render([event])).toContain("thumbnail?v=preview-version");
    const hidden = render([event], { active: false });
    expect(hidden).not.toContain("<img");
    expect(hidden).not.toContain("thumbnail?v=");
    expect(hidden).not.toContain("No archived video");
  });

  it("includes every loaded source in All and its count", () => {
    const markup = render(RECORDING_TYPES.map(recording));
    expect(markup).toContain("Recordings (3)");
    expect(markup).toContain("3 recordings loaded");
    for (const label of ["Saved", "Sentry", "Recent"]) expect(markup).toContain(`Open ${label} recording`);
    expect(markup).toContain("No archived video");
  });

  it("keeps a Recent-only recording discoverable", () => {
    const markup = render([recording("RecentClips")]);
    expect(markup).toContain("Recordings (1)");
    expect(markup).toContain("1 segment");
    expect(markup).not.toContain("No recordings in the loaded archive days");
  });

  it("shows saved recordings during independent background checks", () => {
    const events = [recording("RecentClips")];
    const markup = render(events, { archive: snapshot(events, { pending: new Set([catalogKey("SavedClips")]) }) });
    expect(markup).toContain("Checking for recording updates…");
    expect(markup).toContain("Open Recent recording");
    expect(markup).toContain('role="status"');
  });

  it("reports storage failures without hiding recordings", () => {
    const events = [recording("RecentClips")];
    const markup = render(events, { archive: snapshot(events, { cacheError: "Could not save recordings: quota exceeded" }) });
    expect(markup).toContain('role="alert">Could not save');
    expect(markup).toContain("Open Recent recording");
  });

  it("keeps older dates available during a head refresh or freshness failure", () => {
    const events = [recording("RecentClips")];
    const catalogs = snapshot(events, {}).catalogs;
    catalogs.RecentClips!.dates.push("2026-10-21");
    const key = "RecentClips/2026-10-22";
    for (const changes of [{ pending: new Set([key]) }, { errors: { [key]: "Update failed." } }]) {
      const markup = render(events, { archive: snapshot(events, { catalogs, ...changes }) });
      expect(markup).toContain('class="browse-load-more-hint">Load more recordings</button>');
      expect(markup).not.toContain('class="browse-load-more-hint" disabled');
      if (changes.errors) {
        expect(markup).toContain("Previously loaded recordings are still shown.");
        expect(markup).toContain(">Retry Recent 2026-10-22</button>");
      }
    }
  });

  it("does not render errors for dates removed from the catalog", () => {
    const markup = render([], { archive: snapshot([], { errors: { "RecentClips/2026-10-21": "Obsolete failure" } }) });
    expect(markup).not.toContain("Obsolete failure");
    expect(markup).not.toContain("Retry Recent");
  });

  it("does not claim an empty archive when catalog discovery fails", () => {
    const markup = render([], { archive: snapshot([], { catalogs: {}, errors: { [catalogKey("SavedClips")]: "Dates unavailable." } }) });
    expect(markup).toContain("Saved dates: Dates unavailable.");
    expect(markup).toContain(">Retry Saved dates</button>");
    expect(markup).not.toContain("No recordings in the loaded archive days");
  });

  it("shows an empty state only after successful catalogs settle", () => {
    expect(render([])).toContain("No recordings in the loaded archive days");
    const markup = render([], { archive: snapshot([], { restored: false }) });
    expect(markup).not.toContain("No recordings in the loaded archive days");
  });
});

function clockRecording(timestamp: string, captureTime: string): DashcamEvent {
  const event = recording("RecentClips");
  return { ...event, id: timestamp, timestamp, clips: [{ ...event.clips[0], timestamp, captureTimeMs: Date.parse(captureTime) }] };
}

describe("recording cards across clock changes", () => {
  it("shows the second occurrence before the first and identifies their offsets", () => {
    const first = clockRecording("2026-11-01T01:50:00", "2026-11-01T08:50:00Z");
    const second = clockRecording("2026-11-01T01:20:00", "2026-11-01T09:20:00Z");
    const noVideo = { ...first, id: "metadata-only", timestamp: "2026-11-01T02:30:00", clips: [], totalDurationSec: 0 };
    const markup = render([first, noVideo, second]);
    const labels = [...markup.matchAll(/aria-label="Open Recent recording from ([^"]+)"/g)].map((match) => match[1]);
    expect(labels).toEqual([
      "Sun, Nov 1, 2026, 1:20 AM; UTC−08:00",
      "Sun, Nov 1, 2026, 1:50 AM; UTC−07:00",
      "Sun, Nov 1, 2026, 2:30 AM",
    ]);
    expect(markup.match(/class="browse-card-clock"/g)).toHaveLength(2);
  });

  it("keeps ordinary single-offset dates free of offset labels", () => {
    const markup = render([clockRecording("2026-11-02T01:20:00", "2026-11-02T09:20:00Z")]);
    expect(markup).not.toContain("browse-card-clock");
    expect(markup).not.toContain("UTC−08:00");
  });

  it("labels a recording crossing a clock change without assigning an offset to its trigger", () => {
    const event = clockRecording("2026-11-01T01:50:00", "2026-11-01T08:50:00Z");
    event.type = "SavedClips";
    event.clips.push({ ...event.clips[0], timestamp: "2026-11-01T01:20:00", captureTimeMs: Date.parse("2026-11-01T09:20:00Z") });
    const markup = render([event]);
    expect(markup).toContain("1:50 AM; Clock changes");
    expect(markup).toContain('<span class="browse-card-clock">Clock changes</span>');
    expect(markup).not.toContain("UTC−07:00");
    expect(markup).not.toContain("UTC−08:00");
  });
});
