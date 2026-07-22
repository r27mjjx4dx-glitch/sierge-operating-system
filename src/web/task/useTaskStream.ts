import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalRequestEvent, Task, TaskEvent } from "../../shared/types";
import * as api from "../api";

export interface TaskStream {
  task: Task | null;
  events: TaskEvent[];
  pendingApprovals: ApprovalRequestEvent[];
  /** Live-accumulated planning text (resets each time planning starts over). */
  planStream: string;
  loadError: string | null;
}

/**
 * Subscribes to the task's SSE stream. Events are deduped by id (the server
 * replays everything after a reconnect) and `task_snapshot` frames replace the
 * task object. Also fetches the task once over REST as a fallback so the
 * screen has something to show before the first snapshot arrives.
 */
export function useTaskStream(taskId: string): TaskStream {
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const resolvedRef = useRef<Set<string>>(new Set());
  const notifiedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const seen = new Set<string>();
    const resolved = new Set<string>();
    resolvedRef.current = resolved;
    setTask(null);
    setEvents([]);
    setLoadError(null);
    let cancelled = false;

    // Fallback fetch so the screen isn't blank before the first snapshot.
    api
      .getTask(taskId)
      .then((fetched) => {
        if (!cancelled) setTask((prev) => prev ?? fetched);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Couldn't load this change.");
        }
      });

    const maybeNotify = (event: ApprovalRequestEvent) => {
      // Wait a moment: during replay, the matching "resolved" event arrives
      // almost immediately, and we shouldn't notify about settled questions.
      window.setTimeout(() => {
        if (cancelled) return;
        if (resolved.has(event.approvalId)) return;
        if (notifiedRef.current.has(event.approvalId)) return;
        if (!("Notification" in window) || Notification.permission !== "granted") return;
        notifiedRef.current.add(event.approvalId);
        try {
          new Notification("Sierge needs your answer", { body: event.title });
        } catch {
          // Notifications are best-effort.
        }
      }, 400);
    };

    const unsubscribe = api.subscribeTaskEvents(taskId, (wireEvent) => {
      if (wireEvent.type === "task_snapshot") {
        setTask(wireEvent.task);
        setLoadError(null);
        return;
      }
      if (seen.has(wireEvent.id)) return;
      seen.add(wireEvent.id);
      if (wireEvent.type === "approval_resolved") {
        resolved.add(wireEvent.approvalId);
      }
      setEvents((prev) => [...prev, wireEvent]);
      if (wireEvent.type === "approval_request") {
        maybeNotify(wireEvent);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [taskId]);

  const pendingApprovals = useMemo(() => {
    const resolvedIds = new Set<string>();
    for (const event of events) {
      if (event.type === "approval_resolved") resolvedIds.add(event.approvalId);
    }
    return events.filter(
      (event): event is ApprovalRequestEvent =>
        event.type === "approval_request" && !resolvedIds.has(event.approvalId),
    );
  }, [events]);

  const planStream = useMemo(() => {
    let text = "";
    for (const event of events) {
      if (event.type === "assistant_text" && event.phase === "plan") {
        text += event.delta;
      } else if (event.type === "state_change" && event.to === "planning") {
        // A fresh planning round starts a fresh plan.
        text = "";
      }
    }
    return text;
  }, [events]);

  return { task, events, pendingApprovals, planStream, loadError };
}
