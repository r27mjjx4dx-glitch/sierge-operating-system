import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * All persistent writes in Sierge go through this module. JSON/markdown files
 * are written atomically (temp file + rename) so a crash mid-write can never
 * leave a half-written state file. JSONL audit files are append-only.
 */

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

const TRANSIENT_RENAME_ERRORS = new Set([
  "EPERM",
  "EACCES",
  "EBUSY",
  "ENOTEMPTY",
]);
const RENAME_RETRY_DELAYS_MS = [15, 40, 90, 180];

export async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fsp.writeFile(tmp, content, "utf8");
  // On Windows, rename-over-existing intermittently fails with EPERM/EBUSY
  // when antivirus or the search indexer holds a transient handle on the
  // target. Retry with short backoff before giving up, so a lock blip can't
  // crash a save or a state transition.
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (
        attempt >= RENAME_RETRY_DELAYS_MS.length ||
        !TRANSIENT_RENAME_ERRORS.has(code)
      ) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2) + "\n");
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

export async function readText(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function appendJsonl(
  filePath: string,
  value: unknown,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fsp.appendFile(filePath, JSON.stringify(value) + "\n", "utf8");
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  const raw = await readText(filePath);
  if (raw === null) return [];
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // A torn final line (crash mid-append) is skipped, never fatal.
    }
  }
  return out;
}

export function existsSync(filePath: string): boolean {
  return fs.existsSync(filePath);
}
