import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { TOKEN_PATH } from "./paths.js";

export interface SavedAuth {
  refreshToken: string;
  accessToken?: string;
  expiryDate?: number;
  folderId?: string;
}

export async function loadSavedAuth(): Promise<SavedAuth | null> {
  try {
    const raw = await readFile(TOKEN_PATH, "utf-8");
    return JSON.parse(raw) as SavedAuth;
  } catch {
    return null;
  }
}

export async function saveAuth(data: SavedAuth): Promise<void> {
  await mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(data, null, 2));
}
