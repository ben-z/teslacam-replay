import { recordingWallTimeMs } from "../src/playback.js";

/** Calendar labels of supported archive entries, not recording-content coverage. */
export function oldestArchiveDate(names: readonly string[]): string | null {
  let oldest: string | null = null;
  for (const name of names) {
    const date = name.slice(0, 10);
    recordingWallTimeMs(`${date}_00-00-00`);
    if (oldest === null || date < oldest) oldest = date;
  }
  return oldest;
}
