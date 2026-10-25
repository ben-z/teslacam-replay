import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildTimeline, Timeline } from "./Timeline";
import type { DashcamEvent, EventClip } from "../types";

function event(clips: EventClip[]): DashcamEvent {
  return {
    id: "2026-10-21_23-59-30",
    type: "RecentClips",
    timestamp: "2026-10-21T23:59:30",
    hasThumbnail: false,
    clips,
    totalDurationSec: clips.reduce((sum, clip) => sum + clip.durationSec, 0),
  };
}

function clip(timestamp: string, durationSec: number): EventClip {
  return { timestamp, durationSec, cameras: ["front"] };
}

function render(events: DashcamEvent[], props: Partial<Parameters<typeof Timeline>[0]> = {}): string {
  return renderToStaticMarkup(createElement(Timeline, { events, ...props }));
}

describe("recording timeline", () => {
  it("keeps the older-page action reachable when the loaded page contains no recordings", () => {
    const html = render([], { footer: createElement("button", null, "Load older clips") });
    expect(html).toContain("No recorded video in the loaded pages");
    expect(html.match(/<button>Load older clips<\/button>/g)).toHaveLength(1);
  });

  it("splits footage crossing midnight across its two recorded calendar days", () => {
    const html = render([event([clip("2026-10-21_23-59-30", 60)])]);
    expect(html).toContain("1 recording on 2026-10-21");
    expect(html).toContain("1 recording on 2026-10-22");
    expect(html.match(/class="timeline-session-button"/g)).toHaveLength(2);
    expect(html.match(/class="timeline-segment /g)).toHaveLength(2);
    expect(html).toContain("Approximate recording coverage");
    expect(html).toContain('aria-label="Open recent recording at 11:59 PM on 2026-10-21"');
  });

  it("does not paint missing intervals as continuous recorded footage", () => {
    const html = render([event([
      clip("2026-10-21_10-00-00", 30),
      clip("2026-10-21_10-05-00", 30),
    ])]);
    expect(html.match(/class="timeline-segment /g)).toHaveLength(2);
    expect(html.match(/class="timeline-session-button"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Open recent recording at 10:00 AM on 2026-10-21"');
    expect(html).toContain("about 1m");
  });

  it("uses native buttons for precise list selection instead of enlarging short bars", () => {
    const html = render([event([clip("2026-10-21_10-00-00", 1)])]);
    expect(html).toMatch(/<button type="button"[^>]*class="timeline-segment /);
    expect(html).toMatch(/<button type="button"[^>]*class="timeline-session-button"/);
    const width = html.match(/class="timeline-segment [^>]*style="left:[^;]+;width:([^%]+)%"/);
    expect(Number(width![1])).toBeCloseTo(100 / 86400, 8);
    expect(html).toContain("about &lt;1m");
  });

  it("preserves exact minute labels when fractional-hour arithmetic rounds below a minute", () => {
    const html = render([event([clip("2026-10-21_20-35-00", 60)])]);
    expect(html).toContain('aria-label="Open recent recording at 8:35 PM on 2026-10-21"');
  });

  it("keeps recorded calendar labels stable when the browser timezone changes", () => {
    const recordings = [event([clip("2026-10-21_23-59-30", 60)])];
    const initial = render(recordings);
    vi.stubEnv("TZ", "Pacific/Auckland");
    try {
      expect(render(recordings)).toBe(initial);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("shows the part of a midnight-crossing clip inside the requested date range", () => {
    const crossing = event([clip("2026-10-23_23-59-30", 60)]);
    const endingAtMidnight = {
      ...event([clip("2026-10-23_23-59-00", 60)]),
      id: "2026-10-23_23-59-00",
    };
    const result = buildTimeline([endingAtMidnight, crossing], "2026-10-24");

    expect(result.days.map((day) => day.dateStr)).toEqual(["2026-10-24"]);
    expect(result.days[0].sessions).toHaveLength(1);
    expect(result.days[0].sessions[0].ranges[0].startHour).toBe(0);
    expect(result.days[0].sessions[0].ranges[0].endHour).toBeCloseTo(30 / 3600);
    expect(result.sessionList).toEqual([crossing]);
    const html = render([endingAtMidnight, crossing], { fromDate: "2026-10-24" });
    expect(html).toContain("1 recording on 2026-10-24");
    expect(html).not.toContain("recording on 2026-10-23");
  });

  it("retains complete original recordings for selection and excludes hidden neighbors", () => {
    const shown = event([
      clip("2026-10-23_23-59-00", 60),
      clip("2026-10-24_00-00-00", 60),
    ]);
    const hidden = {
      ...event([clip("2026-10-22_12-00-00", 60)]),
      id: "2026-10-22_12-00-00",
    };
    const recordings = [hidden, shown];
    const before = structuredClone(recordings);
    for (const recording of recordings) {
      for (const entry of recording.clips) {
        Object.freeze(entry.cameras);
        Object.freeze(entry);
      }
      Object.freeze(recording.clips);
      Object.freeze(recording);
    }
    Object.freeze(recordings);

    const result = buildTimeline(recordings, "2026-10-24");
    expect(result.sessionList).toHaveLength(1);
    expect(result.sessionList[0]).toBe(shown);
    expect(result.days[0].sessions[0].event).toBe(shown);
    expect(result.days[0].sessions[0].event.clips).toHaveLength(2);
    expect(recordings).toEqual(before);
  });

  it("uses clip dates rather than recording metadata to decide what is visible", () => {
    const visible = {
      ...event([clip("2026-10-24_12-00-00", 60)]),
      id: "2026-10-24_12-00-00",
      timestamp: "2020-01-01T00:00:00",
    };
    const hidden = {
      ...event([clip("2026-10-22_12-00-00", 60)]),
      id: "2026-10-22_12-00-00",
      timestamp: "2030-01-01T00:00:00",
    };
    const result = buildTimeline([hidden, visible], "2026-10-24");
    expect(result.sessionList).toEqual([visible]);
    expect(result.days.map((day) => day.dateStr)).toEqual(["2026-10-24"]);
  });

  it("counts a recording once across visible days without counting hidden or video-free entries", () => {
    const spanning = event([clip("2026-10-22_23-00-00", 26 * 3600)]);
    const hidden = {
      ...event([clip("2026-10-21_12-00-00", 60)]),
      id: "2026-10-21_12-00-00",
    };
    const noVideo = { ...event([]), id: "2026-10-24_13-00-00" };
    const result = buildTimeline([spanning, hidden, noVideo], "2026-10-23");
    expect(result.days.map((day) => day.dateStr)).toEqual(["2026-10-24", "2026-10-23"]);
    expect(result.days[1].sessions[0].ranges).toEqual([{ startHour: 0, endHour: 24 }]);
    expect(result.days[0].sessions[0].ranges).toEqual([{ startHour: 0, endHour: 1 }]);
    expect(result.sessionList).toEqual([spanning]);
    const html = render([spanning, hidden, noVideo], { fromDate: "2026-10-23" });
    expect(html).toContain("<strong>1</strong> recording shown");
    expect(html).toContain("Video on <strong>2</strong> days");
  });

  it("keeps paging available when loaded footage falls before the date range", () => {
    const html = render([event([clip("2026-10-21_12-00-00", 60)])], {
      fromDate: "2026-10-24",
      footer: createElement("button", null, "Load earlier recordings"),
    });
    expect(html).toContain("No loaded video in this date range");
    expect(html).toContain("<button>Load earlier recordings</button>");
    expect(html).not.toContain("No recorded video in the loaded pages");
  });

  it("keeps recording types with the same timestamp distinct in the visible navigation list", () => {
    const saved = { ...event([clip("2026-10-24_12-00-00", 60)]), type: "SavedClips" as const };
    const sentry = { ...saved, type: "SentryClips" as const };
    const result = buildTimeline([saved, sentry], "2026-10-24");
    expect(new Set(result.sessionList)).toEqual(new Set([saved, sentry]));
    expect(result.sessionList[0]).toBe(saved);
    expect(result.sessionList[1]).toBe(sentry);
    expect(render([saved, sentry], { fromDate: "2026-10-24" })).toContain("<strong>2</strong> recordings shown");
  });

  it("keeps all clip ranges when no date guard is requested", () => {
    const recordings = [event([clip("2026-10-21_23-59-30", 60)])];
    expect(render(recordings)).toBe(render(recordings, { fromDate: "2026-10-21" }));
    expect(buildTimeline(recordings).days.map((day) => day.dateStr)).toEqual(["2026-10-22", "2026-10-21"]);
  });

  it.each(["2026-2-01", "2026-02-30", "2026-10-24T00:00:00", "not-a-date"])("rejects invalid date guard %s", (fromDate) => {
    expect(() => buildTimeline([], fromDate)).toThrow(/Invalid/);
  });
});
