import { afterEach, describe, expect, it, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendJsonl,
  readJson,
  readJsonl,
  writeFileAtomic,
  writeJsonAtomic,
} from "../src/server/fsStore.js";

async function tmpFile(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sierge-fs-"));
  return path.join(dir, "state.json");
}

afterEach(() => vi.restoreAllMocks());

describe("writeFileAtomic", () => {
  it("round-trips content", async () => {
    const f = await tmpFile();
    await writeJsonAtomic(f, { a: 1 });
    expect(await readJson(f, null)).toEqual({ a: 1 });
  });

  it("retries a transient Windows rename lock (EPERM/EBUSY) then succeeds", async () => {
    const f = await tmpFile();
    const real = fsp.rename.bind(fsp);
    let calls = 0;
    const spy = vi.spyOn(fsp, "rename").mockImplementation(async (a, b) => {
      calls += 1;
      if (calls < 3) {
        const err = new Error("locked") as NodeJS.ErrnoException;
        err.code = calls === 1 ? "EPERM" : "EBUSY";
        throw err;
      }
      return real(a as string, b as string);
    });
    await writeFileAtomic(f, "ok");
    expect(calls).toBe(3);
    expect(await fsp.readFile(f, "utf8")).toBe("ok");
    spy.mockRestore();
  });

  it("rethrows a non-transient error and cleans up the temp file", async () => {
    const f = await tmpFile();
    const dir = path.dirname(f);
    vi.spyOn(fsp, "rename").mockImplementation(async () => {
      const err = new Error("nope") as NodeJS.ErrnoException;
      err.code = "ENOSPC";
      throw err;
    });
    await expect(writeFileAtomic(f, "x")).rejects.toThrow();
    // No leftover *.tmp files.
    const leftovers = (await fsp.readdir(dir)).filter((n) => n.endsWith(".tmp"));
    expect(leftovers).toHaveLength(0);
  });
});

describe("jsonl helpers", () => {
  it("appends and reads back, tolerating a torn final line", async () => {
    const f = await tmpFile();
    await appendJsonl(f, { n: 1 });
    await appendJsonl(f, { n: 2 });
    await fsp.appendFile(f, '{"n":3', "utf8"); // torn write (crash mid-append)
    const rows = await readJsonl<{ n: number }>(f);
    expect(rows.map((r) => r.n)).toEqual([1, 2]);
  });
});
