import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { RecordingNavigation } from "./RecordingNavigation";

const total = 21 * 3600;
const offsets = Array.from({ length: 1261 }, (_, index) => index * 60);
const props: ComponentProps<typeof RecordingNavigation> = {
  baseTimestamp: "2026-10-21_00-00-00",
  total,
  position: 0,
  seekTarget: { time: 0 },
  offsets,
  durations: offsets.slice(1).map(() => 60),
  completed: offsets.slice(1).map(() => false),
  trigger: null,
  loading: false,
  estimated: true,
  footageEnd: null,
  onSeek: vi.fn(),
};

function render(overrides: Partial<ComponentProps<typeof RecordingNavigation>> = {}): string {
  return renderToStaticMarkup(<RecordingNavigation {...props} {...overrides} />);
}

describe("recording navigation", () => {
  it("opens a 21-hour recording with 15 minutes of detail and a native overview control", () => {
    const html = render();
    expect(html).toContain('<option value="900" selected="">15 min</option>');
    expect(html).toContain('aria-label="Timeline window position"');
    expect(html).toContain('aria-valuetext="Oct 21, 12:00:00 AM to Oct 21, 12:15:00 AM"');
    expect(html).toContain('aria-label="Earlier timeline window"');
    expect(html).toContain('aria-label="Later timeline window"');
    expect(html).toContain("Follow playhead");
    expect(html).toContain("Jump to time");
    expect(html.match(/class="player-timeline-marker"/g)).toHaveLength(14);
    expect(html.match(/<div/g)!.length).toBeLessThan(30);
  });

  it("initially reveals the selected time near the end of a long recording", () => {
    const html = render({ seekTarget: { time: total - 30 }, position: total - 30 });
    expect(html).toContain('aria-valuetext="Oct 21, 8:45:00 PM to Oct 21, 9:00:00 PM"');
    expect(html).toContain('aria-valuenow="75570"');
    expect(html).toContain("20:59:30 of approximately 21:00:00");
    expect(html).not.toContain("1259:30");
  });

  it("keeps short recordings in the whole-recording view without an unnecessary overview", () => {
    const html = render({ total: 120, offsets: [0, 60, 120], durations: [60, 60], completed: [false, false] });
    expect(html).toContain('<option value="all" selected="">Whole recording</option>');
    expect(html).not.toContain('aria-label="Timeline window position"');
    expect(html).not.toContain('value="900"');
    expect(html).toContain('aria-valuemax="120"');
  });

  it("bounds markers for recordings with a thousand short source files in one window", () => {
    const dense = Array.from({ length: 1001 }, (_, index) => index / 10);
    const html = render({ total: 100, offsets: dense, durations: dense.slice(1).map(() => 0.1), completed: dense.slice(1).map(() => true) });
    expect(html).not.toContain('class="player-timeline-marker"');
    expect(html.match(/<div/g)!.length).toBeLessThan(10);
  });

  it("only paints measured gaps, including a gap crossing the viewport edge", () => {
    const measured = render({
      total: 3600,
      seekTarget: { time: 1200 },
      position: 1200,
      offsets: [0, 800, 3600],
      durations: [600, 2800],
      completed: [true, false],
    });
    const unknown = render({ total: 3600, offsets: [0, 800, 3600], durations: [600, 2800], completed: [false, false] });
    expect(measured).toContain('class="recording-gaps"');
    const path = measured.match(/<path d="M([^,]+),0H([^V]+)V1H([^Z]+)Z"/)!;
    expect(Number(path[1])).toBe(0);
    expect(Number(path[2])).toBeCloseTo(50 / 900 * 100);
    expect(Number(path[3])).toBe(0);
    expect(unknown).not.toContain('class="recording-gaps"');
  });

  it("shows the event marker only when the event moment is inside the visible window", () => {
    expect(render({ trigger: 60 })).toContain('class="player-timeline-trigger"');
    expect(render({ trigger: 3600 })).not.toContain('class="player-timeline-trigger"');
  });

  it("exposes the recording position and local date to keyboard and screen-reader users", () => {
    const html = render({ baseTimestamp: "2026-10-21_23-00-00", seekTarget: { time: 7200 }, position: 7200, estimated: false });
    expect(html).toContain('role="slider" tabindex="0" aria-label="Recording position"');
    expect(html).toContain('aria-valuemin="0" aria-valuemax="75600" aria-valuenow="7200"');
    expect(html).toContain('aria-valuetext="Oct 22, 1:00:00 AM; 2:00:00 of 21:00:00"');
    expect(html).not.toContain("approximately");
    expect(html).toContain('aria-expanded="false"');
  });
});
