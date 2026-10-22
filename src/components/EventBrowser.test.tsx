import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashcamEvent } from "../types";
import { EventBrowser } from "./EventBrowser";

function render(events: DashcamEvent[]) {
  return renderToStaticMarkup(<EventBrowser
    events={events}
    loading={false}
    loadingMore={false}
    error={null}
    hasMore={{ SavedClips: false, SentryClips: false, RecentClips: false }}
    onSelectEvent={() => {}}
    onRefresh={() => {}}
    onRetry={() => {}}
    onLoadMore={() => {}}
  />);
}

function recording(type: DashcamEvent["type"]): DashcamEvent {
  return {
    id: `${type}-2026-10-22_12-00-00`,
    type,
    timestamp: "2026-10-22T12:00:00",
    hasThumbnail: false,
    clips: type === "RecentClips" ? [{ timestamp: "2026-10-22_12-00-00", cameras: ["front"], durationSec: 60 }] : [],
    totalDurationSec: type === "RecentClips" ? 60 : 0,
  };
}

describe("recording list archive scope", () => {
  it("includes every loaded recording type in All and its count", () => {
    const markup = render([recording("SavedClips"), recording("SentryClips"), recording("RecentClips")]);
    expect(markup).toContain("Recordings (3)");
    expect(markup).toContain("3 recordings loaded");
    expect(markup).toContain("Open Saved recording");
    expect(markup).toContain("Open Sentry recording");
    expect(markup).toContain("Open Recent recording");
    expect(markup).toContain("No archived video");
  });

  it("keeps a Recent-only recording discoverable", () => {
    const markup = render([recording("RecentClips")]);
    expect(markup).toContain("Recordings (1)");
    expect(markup).toContain("Open Recent recording");
    expect(markup).toContain("1 segment");
    expect(markup).not.toContain("No recordings in the loaded pages");
  });
});
