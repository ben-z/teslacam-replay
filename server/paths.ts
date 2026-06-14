import path from "path";

/**
 * All cache and data paths, derived from a single configurable root.
 * Set CACHE_DIR env var to override (default: ./cache).
 */
export const CACHE_DIR = path.resolve(process.env.CACHE_DIR || "./cache");

// Persistent data
export const EVENTS_CACHE_PATH = path.join(CACHE_DIR, "events.json");

// Regenerable caches (can be deleted without data loss)
export const HLS_CACHE_DIR = path.join(CACHE_DIR, "hls");
