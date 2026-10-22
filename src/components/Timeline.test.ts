import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Timeline } from "./Timeline";
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
    expect(html).toContain('class="timeline-scroll"');
    expect(html).toContain("Load older clips");
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
});
