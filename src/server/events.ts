import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import path from "node:path";
import { appendJsonl, readJsonl } from "./fsStore.js";
import { taskDataDir } from "./config.js";
import type { TaskEvent, WireEvent } from "../shared/types.js";

export interface TaskRef {
  projectId: string;
  taskId: string;
}

/**
 * Append-only audit log + in-process broadcast. Every task event is written
 * to disk BEFORE being broadcast; the SSE layer replays the file on connect
 * and then follows the live bus, so restarts lose nothing.
 */
class TaskEventHub {
  private bus = new EventEmitter();

  constructor() {
    this.bus.setMaxListeners(100);
  }

  eventsFile(ref: TaskRef): string {
    return path.join(taskDataDir(ref.projectId, ref.taskId), "events.jsonl");
  }

  /** Persist an audit event, then broadcast it. Returns the full event. */
  async emit<T extends Omit<TaskEvent, "id" | "ts">>(
    ref: TaskRef,
    partial: T,
  ): Promise<TaskEvent> {
    const event = {
      ...partial,
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
    } as unknown as TaskEvent;
    await appendJsonl(this.eventsFile(ref), event);
    this.bus.emit(ref.taskId, event);
    return event;
  }

  /** Broadcast a non-persisted wire event (e.g. task snapshots). */
  broadcast(ref: TaskRef, event: WireEvent): void {
    this.bus.emit(ref.taskId, event);
  }

  async replay(ref: TaskRef): Promise<TaskEvent[]> {
    return readJsonl<TaskEvent>(this.eventsFile(ref));
  }

  subscribe(taskId: string, listener: (event: WireEvent) => void): () => void {
    this.bus.on(taskId, listener);
    return () => this.bus.off(taskId, listener);
  }
}

export const taskEvents = new TaskEventHub();
