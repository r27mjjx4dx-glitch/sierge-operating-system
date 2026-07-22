import { beforeAll, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WireEvent } from "../src/shared/types.js";

let events: typeof import("../src/server/events.js");

beforeAll(async () => {
  process.env.SIERGE_DATA_DIR = await fsp.mkdtemp(
    path.join(os.tmpdir(), "sierge-events-data-"),
  );
  events = await import("../src/server/events.js");
});

const ref = { projectId: "p", taskId: "t-events" };

describe("task event hub (SSE ordering contract)", () => {
  it("persists then broadcasts; replay returns persisted events in order", async () => {
    const live: WireEvent[] = [];
    const unsub = events.taskEvents.subscribe(ref.taskId, (e) => live.push(e));

    await events.taskEvents.emit(ref, {
      type: "system_note",
      taskId: ref.taskId,
      level: "info",
      text: "first",
    });
    await events.taskEvents.emit(ref, {
      type: "system_note",
      taskId: ref.taskId,
      level: "info",
      text: "second",
    });
    unsub();

    // Live subscriber saw both, in order, each with a stable id + ts.
    expect(live).toHaveLength(2);
    const texts = live.map((e) => (e as { text?: string }).text);
    expect(texts).toEqual(["first", "second"]);
    for (const e of live) {
      expect((e as { id?: string }).id).toBeTruthy();
      expect((e as { ts?: string }).ts).toBeTruthy();
    }

    // Replay from disk returns the same persisted events (audit is complete).
    const replayed = await events.taskEvents.replay(ref);
    expect(replayed.map((e) => (e as { text?: string }).text)).toEqual([
      "first",
      "second",
    ]);

    // Live ids match persisted ids, enabling the SSE dedup on reconnect.
    expect(live.map((e) => (e as { id?: string }).id)).toEqual(
      replayed.map((e) => e.id),
    );
  });

  it("broadcast (snapshot) is delivered live but NOT persisted", async () => {
    const ref2 = { projectId: "p", taskId: "t-snap" };
    const live: WireEvent[] = [];
    const unsub = events.taskEvents.subscribe(ref2.taskId, (e) => live.push(e));
    events.taskEvents.broadcast(ref2, {
      type: "task_snapshot",
      // minimal shape; the hub does not inspect it
      task: { id: "t-snap" } as never,
    });
    unsub();
    expect(live).toHaveLength(1);
    expect((live[0] as { type: string }).type).toBe("task_snapshot");
    const replayed = await events.taskEvents.replay(ref2);
    expect(replayed).toHaveLength(0);
  });
});
