import { describe, expect, it } from "vitest";
import { timelinePaging } from "./timelinePaging";
import type { EventPagePositions } from "./api";
import type { DashcamEvent } from "./types";

function event(timestamp: string): DashcamEvent {
  return {
    id: timestamp, type: "RecentClips", timestamp: "2000-01-01T00:00:00",
    hasThumbnail: false, totalDurationSec: 60,
    clips: [{ timestamp, durationSec: 60, cameras: ["front"] }],
  };
}

const recordings = [event("2026-10-24_12-00-00")];
const positions: EventPagePositions = {
  SavedClips: { nextPageToken: "saved", nextPageDate: "2026-10-04" },
  SentryClips: { nextPageToken: "sentry", nextPageDate: "2026-10-20" },
  RecentClips: { nextPageToken: "recent", nextPageDate: "2026-10-24" },
};

describe("common Timeline date range", () => {
  it("loads dense Recent before extending already deeper sparse sources", () => {
    expect(timelinePaging(recordings, positions)).toEqual({
      fromDate: "2026-10-24", loadTypes: ["RecentClips"], incomplete: true,
    });
    expect(timelinePaging(recordings, {
      ...positions, RecentClips: { nextPageToken: "recent-2", nextPageDate: "2026-10-23" },
    })).toEqual({ fromDate: "2026-10-23", loadTypes: ["RecentClips"], incomplete: true });
  });

  it("does not promise an earlier day when another page still covers the boundary day", () => {
    expect(timelinePaging(recordings, {
      ...positions, RecentClips: { nextPageToken: "same-day-next", nextPageDate: "2026-10-24" },
    })).toEqual(timelinePaging(recordings, positions));
  });

  it("loads every source tied at the newest day", () => {
    expect(timelinePaging(recordings, {
      ...positions, SavedClips: { nextPageToken: "saved", nextPageDate: "2026-10-24" },
    }).loadTypes).toEqual(["SavedClips", "RecentClips"]);
  });

  it("does not let an exhausted source hold back the common range", () => {
    expect(timelinePaging(recordings, {
      ...positions, RecentClips: { nextPageToken: null, nextPageDate: null },
    })).toEqual({ fromDate: "2026-10-20", loadTypes: ["SentryClips"], incomplete: true });
  });

  it("shows the full loaded history once every source is exhausted", () => {
    expect(timelinePaging(recordings, {
      SavedClips: { nextPageToken: null, nextPageDate: null },
      SentryClips: { nextPageToken: null, nextPageDate: null },
      RecentClips: { nextPageToken: null, nextPageDate: null },
    })).toEqual({ fromDate: undefined, loadTypes: [], incomplete: false });
  });

  it("prioritizes an empty continuation whose archive date is still unknown", () => {
    expect(timelinePaging(recordings, {
      ...positions, SavedClips: { nextPageToken: "empty-next", nextPageDate: null },
    })).toEqual({ fromDate: "2026-10-24", loadTypes: ["SavedClips"], incomplete: true });
  });

  it("keeps an unresolved initial source from declaring older history aligned", () => {
    const { SentryClips: _unresolved, ...partial } = positions;
    expect(timelinePaging(recordings, partial)).toEqual({
      fromDate: "2026-10-24", loadTypes: [], incomplete: true,
    });
  });

  it("uses clip wall time instead of event metadata or the device timezone", () => {
    expect(timelinePaging([event("2026-10-24_23-59-30")], {}).fromDate).toBe("2026-10-25");
    const endsAtMidnight = event("2026-10-24_23-59-00");
    expect(timelinePaging([endsAtMidnight], {}).fromDate).toBe("2026-10-24");
  });

  it("does not hide all loaded footage when an unseen archive head is newer", () => {
    expect(timelinePaging([event("2026-10-21_12-00-00")], positions).fromDate).toBe("2026-10-21");
    expect(timelinePaging([], positions).fromDate).toBe("2026-10-24");
  });

  it("does not infer exhaustion or a date from an empty catalog", () => {
    expect(timelinePaging([], {})).toEqual({ fromDate: undefined, loadTypes: [], incomplete: true });
  });
});
