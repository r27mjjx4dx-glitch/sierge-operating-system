import { useEffect } from "react";
import type { Task } from "../../shared/types";
import { ErrorNote, Spinner, StatusBadge } from "../ui";
import { useTaskStream } from "../task/useTaskStream";
import { ActivityFeed } from "../task/ActivityFeed";
import { ApprovalCard } from "../task/ApprovalCard";
import { PlanPanel } from "../task/PlanPanel";
import { DecisionBar, ReviewPanel } from "../task/ReviewPanel";
import {
  AcceptedPanel,
  BuildingPanel,
  DiscardedPanel,
  FailedPanel,
  PlanningPanel,
} from "../task/StatusPanels";

export function TaskScreen({ taskId }: { taskId: string }) {
  const { task, events, pendingApprovals, planStream, loadError } = useTaskStream(taskId);

  // Ask for notification permission lazily, so we can tap the owner on the
  // shoulder when Claude has a question.
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => {});
    }
  }, []);

  if (!task) {
    return (
      <div>
        {loadError ? (
          <div>
            <ErrorNote message={loadError} />
            <a href="#/" className="mt-4 inline-block text-sm text-indigo-600 hover:underline">
              Back to your projects
            </a>
          </div>
        ) : (
          <Spinner label="Loading this change…" />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <TaskHeader task={task} />

      {pendingApprovals.map((approval) => (
        <ApprovalCard key={approval.approvalId} taskId={taskId} approval={approval} />
      ))}

      <StatusPanel task={task} planStream={planStream} />

      <ActivityFeed events={events} />

      {task.status === "review" ? <DecisionBar taskId={taskId} /> : null}
    </div>
  );
}

function TaskHeader({ task }: { task: Task }) {
  return (
    <div>
      <a
        href={`#/project/${encodeURIComponent(task.projectId)}`}
        className="text-sm text-indigo-600 hover:underline"
      >
        &larr; Back to the project
      </a>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{task.title}</h1>
        <StatusBadge status={task.status} />
        {task.costUsdEstimate > 0 ? (
          <span className="text-sm text-slate-400">
            ~${task.costUsdEstimate.toFixed(2)} (estimate)
          </span>
        ) : null}
      </div>
      {task.ownerRequest ? (
        <details className="mt-2">
          <summary className="text-sm text-slate-400 hover:text-slate-600">
            What you asked for
          </summary>
          <p className="mt-1 whitespace-pre-wrap rounded-lg bg-slate-100 p-3 text-sm text-slate-600">
            {task.ownerRequest}
          </p>
        </details>
      ) : null}
    </div>
  );
}

function StatusPanel({ task, planStream }: { task: Task; planStream: string }) {
  switch (task.status) {
    case "draft":
    case "planning":
      return <PlanningPanel task={task} planStream={planStream} />;
    case "plan_ready":
      return <PlanPanel task={task} />;
    case "implementing":
      return <BuildingPanel validating={false} />;
    case "validating":
      return <BuildingPanel validating={true} />;
    case "review":
      return <ReviewPanel task={task} />;
    case "failed":
      return <FailedPanel task={task} />;
    case "accepted":
      return <AcceptedPanel task={task} />;
    case "discarded":
      return <DiscardedPanel task={task} />;
  }
}
