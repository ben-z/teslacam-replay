import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import type { DashcamEvent } from "../types";
import { EventBrowser } from "./EventBrowser";
import { EVENT_PAGE_TYPES, type EventPagePositions, type EventPageType } from "../api";

function positions(hasMore: Record<EventPageType, boolean>): EventPagePositions {
  return Object.fromEntries(EVENT_PAGE_TYPES.map((type) => [type, {
    nextPageToken: hasMore[type] ? `older-${type}` : null,
    nextPageDate: hasMore[type] ? "2026-10-22" : null,
  }]));
}

function render(events: DashcamEvent[], overrides: Partial<ComponentProps<typeof EventBrowser>> = {}) {
  return renderToStaticMarkup(<EventBrowser
    active={true}
    events={events}
    pendingTypes={[]}
    errorsByType={{}}
    pagePositions={positions({ SavedClips: false, SentryClips: false, RecentClips: false })}
    onSelectEvent={() => {}}
    onRefresh={() => {}}
    onRetry={() => {}}
    onLoadMore={() => {}}
    {...overrides}
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
  it("loads advertised previews lazily only while browsing is active", () => {
    const event = { ...recording("RecentClips"), hasThumbnail: true, thumbnailVersion: "preview-version" };
    const active = render([event]);
    expect(active).toContain('loading="lazy"');
    expect(active).toContain("thumbnail?v=preview-version");
    expect(active).not.toContain("No preview");
    const hidden = render([event], { active: false });
    expect(hidden).not.toContain("<img");
    expect(hidden).not.toContain("thumbnail?v=");
    expect(hidden).not.toContain("No archived video");
  });
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

  it("shows completed sources while another source is pending", () => {
    const markup = render([recording("RecentClips"), recording("SentryClips")], {
      pendingTypes: ["SavedClips"],
    });
    expect(markup).toContain("Loading Saved recordings…");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Open Recent recording");
    expect(markup).toContain("Open Sentry recording");
    expect(markup).toContain("2 recordings loaded");
    expect(markup).not.toContain("No recordings in the loaded pages");
  });

  it("names a failed source without hiding successful recordings", () => {
    const markup = render([recording("RecentClips")], {
      errorsByType: { SavedClips: "Could not load recordings (HTTP 500)." },
    });
    expect(markup).toContain("Saved: Could not load recordings (HTTP 500).");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(">Retry Saved</button>");
    expect(markup).toContain("Open Recent recording");
    expect(markup).not.toContain("Previously loaded Saved");
  });

  it("discloses retained recordings when their source fails", () => {
    const markup = render([recording("SavedClips"), recording("RecentClips")], {
      errorsByType: { SavedClips: "Refresh failed." },
    });
    expect(markup).toContain("Open Saved recording");
    expect(markup).toContain("Previously loaded Saved recordings are still shown.");
    expect(markup).toContain(">Retry Saved</button>");
    expect(markup).toContain("Open Recent recording");
  });

  it("keeps retries available while an unrelated source is pending", () => {
    const markup = render([], {
      pendingTypes: ["SentryClips"],
      errorsByType: { SavedClips: "Saved listing failed.", RecentClips: "Recent listing failed." },
    });
    expect(markup).toContain("Loading Sentry recordings…");
    expect(markup).toContain("Saved listing failed.");
    expect(markup).toContain("Recent listing failed.");
    expect(markup).toContain("<button>Retry Saved</button>");
    expect(markup).toContain("<button>Retry Recent</button>");
    expect(markup).toMatch(/<button disabled="" class="browse-refresh-btn"/);
    expect(markup).not.toContain("No recordings in the loaded pages");
  });

  it("disables only a retry whose own source is pending", () => {
    const markup = render([], {
      pendingTypes: ["SavedClips"],
      errorsByType: { SavedClips: "Saved listing failed.", RecentClips: "Recent listing failed." },
    });
    expect(markup).toContain('<button disabled="">Retry Saved</button>');
    expect(markup).toContain("<button>Retry Recent</button>");
  });

  it("allows an idle continuation while another source is pending", () => {
    const markup = render([recording("SavedClips")], {
      pendingTypes: ["SentryClips"],
      pagePositions: positions({ SavedClips: true, SentryClips: true, RecentClips: false }),
    });
    expect(markup).toContain("Loading Sentry recordings…");
    expect(markup).toContain('class="browse-load-more-hint">Load more recordings</button>');
    expect(markup).not.toContain('class="browse-load-more-hint" disabled=""');
    expect(markup).toContain("Older recordings are available");
  });

  it("keeps a pending continuation visible without reporting exhaustion", () => {
    const markup = render([recording("SavedClips")], {
      pendingTypes: ["SavedClips"],
      pagePositions: positions({ SavedClips: true, SentryClips: false, RecentClips: false }),
    });
    expect(markup).toContain('class="browse-load-more-hint" disabled="">Load more recordings</button>');
    expect(markup).toContain("Older recordings are available");
    expect(markup).not.toContain("No older recordings");
  });

  it("keeps loaded recordings revealable while their source is pending", () => {
    const events = Array.from({ length: 49 }, (_, index) => ({
      ...recording("RecentClips"),
      id: `recent-${index}`,
    }));
    const markup = render(events, { pendingTypes: ["RecentClips"] });
    expect(markup).toContain('class="browse-load-more-hint">Show more recordings</button>');
    expect(markup).not.toContain('class="browse-load-more-hint" disabled=""');
  });

  it("does not claim an empty archive before its sources finish", () => {
    const markup = render([], { pendingTypes: ["SavedClips", "SentryClips", "RecentClips"] });
    expect(markup).toContain("Loading Saved, Sentry, Recent recordings…");
    expect(markup.match(/role="status"/g)).toHaveLength(1);
    expect(markup).not.toContain("No recordings in the loaded pages");
    expect(markup).not.toContain("Loading recordings...");
  });

  it("does not report a failed listing as an empty archive", () => {
    const markup = render([], { errorsByType: { SavedClips: "Listing failed." } });
    expect(markup).toContain("Saved: Listing failed.");
    expect(markup).not.toContain("No recordings in the loaded pages");
  });

  it("keeps failed continuation pages behind their explicit Retry action", () => {
    const markup = render([recording("RecentClips")], {
      errorsByType: { RecentClips: "Older page failed." },
      pagePositions: positions({ SavedClips: false, SentryClips: false, RecentClips: true }),
    });
    expect(markup).toContain(">Retry Recent</button>");
    expect(markup).not.toContain("Load more recordings");
    expect(markup).not.toContain("Older recordings are available");
  });

  it("shows an empty state after successful sources settle", () => {
    const markup = render([]);
    expect(markup).toContain("No recordings in the loaded pages");
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
  });
});
