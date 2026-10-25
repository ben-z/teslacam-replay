import { recordingWallTimeMs } from "../src/playback.js";

/** Calendar labels of supported archive entries, not recording-content coverage. */
export function archiveDateBounds(names: readonly string[]): {
  oldest: string | null;
  newest: string | null;
} {
  let oldest: string | null = null;
  let newest: string | null = null;
  for (const name of names) {
    const date = name.slice(0, 10);
    recordingWallTimeMs(`${date}_00-00-00`);
    if (oldest === null || date < oldest) oldest = date;
    if (newest === null || date > newest) newest = date;
  }
  return { oldest, newest };
}

/** Undefined means no remaining entries; null means their dates are unknown. */
export function maximumRemainingArchiveDate(
  candidates: readonly (string | null | undefined)[],
): string | null {
  let newest: string | null = null;
  for (const date of candidates) {
    if (date === null) return null;
    if (date !== undefined && (newest === null || date > newest)) newest = date;
  }
  return newest;
}
