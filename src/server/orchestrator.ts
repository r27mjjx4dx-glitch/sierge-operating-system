import { runAgentPhase } from "./agent/adapter.js";
import {
  buildFixPrompt,
  buildImplementPrompt,
  buildPlanPrompt,
  buildSummarizePrompt,
} from "./agent/prompts.js";
import { extractFileDescriptions, makePlan } from "./agent/planParse.js";
import {
  appendDecision,
  composeContextBundle,
} from "./stores/projects.js";
import { listTasks, loadTask, saveTask, transition } from "./stores/tasks.js";
import {
  branchExists,
  changedFiles,
  checkpointWorktree,
  diffStat,
  isMergedIntoMain,
  mainHeadSha,
  mergeTask,
  removeTaskWorktree,
} from "./gitManager.js";
import { runValidation } from "./validation.js";
import { stopPreview } from "./preview.js";
import { ensureSelfTest } from "./policy/selftest.js";
import { taskEvents, type TaskRef } from "./events.js";
import { readJsonl } from "./fsStore.js";
import { MAX_AUTOFIX_ROUNDS } from "./config.js";
import type {
  ProjectSummary,
  ReviewPacket,
  Task,
  TaskEvent,
} from "../shared/types.js";

/**
 * The orchestrator drives the 9-step build cycle. Approval is a state-machine
 * gate: nothing can reach implementation except through approvePlan(), and
 * nothing reaches the owner's main branch except through accept().
 *
 * One agent run per project at a time (in-process mutex).
 */

const busyProjects = new Set<string>();

function ref(task: Task): TaskRef {
  return { projectId: task.projectId, taskId: task.id };
}

function requireIdle(projectId: string): void {
  if (busyProjects.has(projectId)) {
    throw new Error(
      "Claude is already working on this project. Wait for the current task to finish.",
    );
  }
}

async function note(
  task: Task,
  level: "info" | "warn" | "error",
  text: string,
): Promise<void> {
  await taskEvents.emit(ref(task), {
    type: "system_note",
    taskId: task.id,
    level,
    text,
  });
}

// ---------------------------------------------------------------------------
// Step 4: planning
// ---------------------------------------------------------------------------

export async function startPlanning(
  project: ProjectSummary,
  task: Task,
): Promise<void> {
  requireIdle(project.id);
  busyProjects.add(project.id); // acquired synchronously — no double-start window

  try {
    // A newly (re)planned task always needs fresh owner approval before it can
    // implement — clear any stale approval from a prior plan version.
    task.planApproved = false;
    await transition(task, "planning", null);
    // ADR-0002 gate: no task may run unless the permission-ordering
    // self-test has passed against the installed SDK version.
    await note(
      task,
      "info",
      "Checking Sierge's safety controls against the installed Claude SDK…",
    );
    const selfTest = await ensureSelfTest();
    if (selfTest.status !== "passed") {
      await saveTask(task);
      await transition(
        task,
        "failed",
        `Sierge's safety self-test did not pass, so no work was started. Detail: ${selfTest.detail}`,
      );
      return;
    }
    const context = await composeContextBundle(project);
    const result = await runAgentPhase({
      ref: ref(task),
      worktreePath: task.worktreePath,
      phase: "plan",
      prompt: buildPlanPrompt(context, task.ownerRequest),
      resumeSessionId: task.planSessionId,
    });

    task.costUsdEstimate += result.costUsd;
    if (result.sessionId) task.planSessionId = result.sessionId;

    if (!result.ok || !result.finalText.trim()) {
      await saveTask(task);
      await transition(
        task,
        "failed",
        result.errorDetail ?? "Planning ended without producing a plan.",
      );
      return;
    }

    const version = (task.plan?.version ?? 0) + 1;
    task.plan = makePlan(result.finalText, version, false);
    task.planHistory = [...task.planHistory, task.plan];
    await saveTask(task);
    await transition(task, "plan_ready", null);
  } catch (err) {
    await transition(task, "failed", `Planning failed: ${String(err).slice(0, 300)}`);
  } finally {
    busyProjects.delete(project.id);
  }
}

// ---------------------------------------------------------------------------
// Step 5: owner approval (the only gate into implementation)
// ---------------------------------------------------------------------------

export async function approvePlan(
  project: ProjectSummary,
  task: Task,
  markdown: string,
): Promise<void> {
  if (task.status !== "plan_ready") {
    throw new Error("There is no plan awaiting approval on this task.");
  }
  // Acquire the mutex SYNCHRONOUSLY right after the idle check — no await
  // between them — so two concurrent approvals can't both pass requireIdle.
  requireIdle(project.id);
  busyProjects.add(project.id);

  let handedOff = false;
  try {
    const edited = markdown.trim() !== (task.plan?.markdown ?? "").trim();
    const version = (task.plan?.version ?? 0) + (edited ? 1 : 0);
    task.plan = makePlan(markdown, version, edited);
    if (edited) task.planHistory = [...task.planHistory, task.plan];
    task.planApproved = true; // gates the failed -> implementing retry path
    await saveTask(task);

    await taskEvents.emit(ref(task), {
      type: "owner_action",
      taskId: task.id,
      action: edited ? "plan_edited" : "plan_approved",
      detail: edited ? "Owner edited the plan before approving." : null,
    });
    await appendDecision(
      project,
      `Approved plan v${task.plan.version} for "${task.title}": ${task.plan.sections.outcome ?? task.ownerRequest.slice(0, 120)}`,
    );

    await transition(task, "implementing", null);
    handedOff = true;
    // Long-running: runs in the background; progress streams over SSE.
    // runImplementation owns the mutex from here (idempotent add + finally).
    void runImplementation(project, task, buildImplementPrompt(task.plan));
  } finally {
    if (!handedOff) busyProjects.delete(project.id);
  }
}

// ---------------------------------------------------------------------------
// Steps 6-7: implementation + Sierge-run validation (with visible fix rounds)
// ---------------------------------------------------------------------------

async function runImplementation(
  project: ProjectSummary,
  task: Task,
  prompt: string,
): Promise<void> {
  busyProjects.add(project.id);
  try {
    let fixRound = 0;
    let currentPrompt = prompt;

    for (;;) {
      const result = await runAgentPhase({
        ref: ref(task),
        worktreePath: task.worktreePath,
        phase: "implement",
        // First round continues the plan session (same cwd — ADR-0002);
        // fix rounds continue the implementation session.
        resumeSessionId: task.implSessionId ?? task.planSessionId,
        prompt: currentPrompt,
      });
      task.costUsdEstimate += result.costUsd;
      if (result.sessionId) task.implSessionId = result.sessionId;
      await saveTask(task);

      await checkpointWorktree(
        task.worktreePath,
        "Sierge checkpoint: preserve uncommitted agent work",
      ).catch(() => {});

      if (!result.ok) {
        await transition(
          task,
          "failed",
          result.errorDetail ?? "The implementation session ended abnormally.",
        );
        return;
      }

      await transition(task, "validating", null);
      const report = await runValidation(
        task.worktreePath,
        task.projectId,
        task.id,
        fixRound,
      );
      task.validation = report;
      await saveTask(task);
      await taskEvents.emit(ref(task), {
        type: "validation",
        taskId: task.id,
        report,
      });

      if (report.overall !== "failed") break;

      if (fixRound >= MAX_AUTOFIX_ROUNDS) {
        await note(
          task,
          "warn",
          `Checks are still failing after ${fixRound} automatic fix attempts. The work is preserved for your review — it is NOT complete.`,
        );
        break;
      }

      fixRound += 1;
      await note(
        task,
        "warn",
        `Some checks failed. Asking Claude to fix them (attempt ${fixRound} of ${MAX_AUTOFIX_ROUNDS}).`,
      );
      await transition(task, "implementing", `auto-fix round ${fixRound}`);
      currentPrompt = buildFixPrompt(report);
    }

    await buildReviewPacket(project, task);
    await transition(task, "review", null);
  } catch (err) {
    await transition(
      task,
      "failed",
      `Implementation failed: ${String(err).slice(0, 300)}`,
    );
  } finally {
    busyProjects.delete(project.id);
  }
}

// ---------------------------------------------------------------------------
// Step 9: review packet (honesty is computed, not narrated)
// ---------------------------------------------------------------------------

async function buildReviewPacket(
  project: ProjectSummary,
  task: Task,
): Promise<void> {
  const files = await changedFiles(
    project.repoPath,
    task.branchName,
    project.defaultBranch,
  );
  const stat = await diffStat(
    project.repoPath,
    task.branchName,
    project.defaultBranch,
  ).catch(() => null);

  // One cheap resumed query for the plain-language summary while context is hot.
  let summaryMarkdown: string | null = null;
  if (task.implSessionId) {
    const summary = await runAgentPhase({
      ref: ref(task),
      worktreePath: task.worktreePath,
      phase: "summarize",
      resumeSessionId: task.implSessionId,
      prompt: buildSummarizePrompt(task.plan, files),
    });
    task.costUsdEstimate += summary.costUsd;
    if (summary.ok && summary.finalText.trim()) {
      summaryMarkdown = summary.finalText;
      const descriptions = extractFileDescriptions(summaryMarkdown);
      for (const f of files) {
        f.plainDescription = descriptions.get(f.path) ?? null;
      }
    }
  }

  // Machine-derived caveats — computed from the audit log and real evidence.
  const caveats: string[] = [];
  const events = await readJsonl<TaskEvent>(
    taskEvents.eventsFile(ref(task)),
  );
  const denials = events.filter(
    (e) =>
      e.type === "policy_decision" &&
      (e.decision === "deny" ||
        e.decision === "ask_deny" ||
        e.decision === "ask_timeout_deny"),
  ).length;
  if (denials > 0) {
    caveats.push(
      `${denials} attempted action(s) were blocked or declined during this task — see the activity log.`,
    );
  }
  const validation = task.validation;
  if (validation) {
    const unavailable = validation.checks.filter(
      (c) => c.status === "unavailable",
    );
    if (unavailable.length > 0) {
      caveats.push(
        `Not verified automatically: ${unavailable.map((c) => c.name).join(", ")} — this project has no such checks configured.`,
      );
    }
    if (validation.overall === "failed") {
      caveats.push(
        "Some checks are FAILING. This work is not complete — review the evidence before deciding.",
      );
    }
  } else {
    caveats.push("No validation was run for this task.");
  }
  if (summaryMarkdown) {
    const unmet = summaryMarkdown
      .split("\n")
      .filter((l) => /^\s*-?\s*(Not met|Unverified):/i.test(l)).length;
    if (unmet > 0) {
      caveats.push(
        `${unmet} acceptance criteri${unmet === 1 ? "on is" : "a are"} reported as not met or unverified.`,
      );
    }
  } else {
    caveats.push("Claude did not produce a summary; review the changed files directly.");
  }

  const packet: ReviewPacket = {
    summaryMarkdown,
    changedFiles: files,
    diffStat: stat,
    validation: task.validation,
    caveats,
    costUsdEstimate: task.costUsdEstimate,
  };
  task.review = packet;
  await saveTask(task);
}

// ---------------------------------------------------------------------------
// Owner decisions from the review screen
// ---------------------------------------------------------------------------

export async function acceptTask(
  project: ProjectSummary,
  task: Task,
): Promise<void> {
  if (task.status !== "review") {
    throw new Error("Only a task in review can be accepted.");
  }
  // Same synchronous mutex as the other mutating handlers, so a concurrent
  // accept/discard/request-changes on this task can't interleave with the
  // merge + worktree removal.
  requireIdle(project.id);
  busyProjects.add(project.id);
  try {
    // Persist an accept-intent marker BEFORE touching git so a crash between
    // the merge and the final transition is reconcilable on restart.
    task.acceptInProgress = true;
    await saveTask(task);

    await stopPreview(task.id);
    await checkpointWorktree(
      task.worktreePath,
      "Sierge checkpoint before merge",
    ).catch(() => {});

    const sha = await mergeTask(
      project.repoPath,
      task.branchName,
      `Accept: ${task.title} (Sierge task ${task.id})`,
      project.defaultBranch,
    );
    task.acceptMergeSha = sha;
    await saveTask(task); // record the merge before cleanup
    await removeTaskWorktree(project.repoPath, project.id, task.id, "delete-merged");

    await taskEvents.emit(ref(task), {
      type: "owner_action",
      taskId: task.id,
      action: "accepted",
      detail: `Merged as ${sha.slice(0, 10)}`,
    });
    await appendDecision(project, `Accepted "${task.title}" (merge ${sha.slice(0, 10)}).`);
    task.acceptInProgress = false;
    await transition(task, "accepted", null);
  } finally {
    busyProjects.delete(project.id);
  }
}

export async function discardTask(
  project: ProjectSummary,
  task: Task,
): Promise<void> {
  if (["accepted", "discarded"].includes(task.status)) {
    throw new Error("This task is already finished.");
  }
  if (busyProjects.has(project.id)) {
    throw new Error(
      "Claude is still working. Wait for the current step to finish before discarding.",
    );
  }
  await stopPreview(task.id);
  await removeTaskWorktree(project.repoPath, project.id, task.id, "force-delete");
  await taskEvents.emit(ref(task), {
    type: "owner_action",
    taskId: task.id,
    action: "discarded",
    detail: null,
  });
  await appendDecision(project, `Discarded "${task.title}" without merging.`);
  await transition(task, "discarded", null);
}

export async function requestChanges(
  project: ProjectSummary,
  task: Task,
  feedback: string,
): Promise<void> {
  // A task may only enter implementation via an owner-approved plan. From
  // "review" that is guaranteed; from "failed" it is only valid if the plan
  // was actually approved (a task that failed during PLANNING has none — it
  // must go back through planning, not straight into implementation).
  if (task.status === "review") {
    // ok
  } else if (task.status === "failed" && task.planApproved) {
    // ok — resume a post-approval failure
  } else {
    throw new Error(
      "Changes can be requested from the review screen, or on a task whose plan you already approved. Write and approve a plan first.",
    );
  }
  // Acquire the mutex synchronously right after the idle check.
  requireIdle(project.id);
  busyProjects.add(project.id);

  let handedOff = false;
  try {
    await stopPreview(task.id);
    await taskEvents.emit(ref(task), {
      type: "owner_action",
      taskId: task.id,
      action: "changes_requested",
      detail: feedback,
    });
    await transition(task, "implementing", "owner requested changes");
    handedOff = true;
    void runImplementation(
      project,
      task,
      `The owner reviewed your work and requests changes. Address the feedback below, then commit.\n\n=== OWNER FEEDBACK ===\n${feedback}\n=== END FEEDBACK ===`,
    );
  } finally {
    if (!handedOff) busyProjects.delete(project.id);
  }
}

/**
 * Startup reconciliation for accepts interrupted by a crash. A task left in
 * "review" with acceptInProgress set is checked against git: if its branch is
 * already merged into main (or was deleted after a successful merge), the
 * accept is completed idempotently; otherwise the merge never happened and the
 * marker is cleared, leaving the task safely in review. This upholds the
 * "never silently done, never silently lost" guarantee across a crash.
 */
export async function reconcileInterruptedAccepts(
  projects: ProjectSummary[],
): Promise<number> {
  let reconciled = 0;
  for (const project of projects) {
    for (const task of await listTasks(project.id)) {
      if (task.status !== "review" || !task.acceptInProgress) continue;

      const exists = await branchExists(project.repoPath, task.branchName);
      const merged =
        !exists ||
        (await isMergedIntoMain(
          project.repoPath,
          task.branchName,
          project.defaultBranch,
        ));

      if (merged) {
        // The merge completed before the crash — finish the accept.
        const sha =
          task.acceptMergeSha ??
          (await mainHeadSha(project.repoPath, project.defaultBranch));
        await removeTaskWorktree(
          project.repoPath,
          project.id,
          task.id,
          "delete-merged",
        ).catch(() => {});
        await taskEvents.emit(ref(task), {
          type: "owner_action",
          taskId: task.id,
          action: "accepted",
          detail: `Merged as ${sha.slice(0, 10)} (completed after restart)`,
        });
        await appendDecision(
          project,
          `Accepted "${task.title}" (merge ${sha.slice(0, 10)}; completed after a restart).`,
        );
        task.acceptInProgress = false;
        task.acceptMergeSha = sha;
        await transition(task, "accepted", "accept completed after restart");
      } else {
        // The merge never happened — leave the task in review.
        task.acceptInProgress = false;
        await saveTask(task);
        await taskEvents.emit(ref(task), {
          type: "system_note",
          taskId: task.id,
          level: "info",
          text: "Sierge restarted before this change was accepted. It is safe and unchanged — you can review and accept it again.",
        });
      }
      reconciled += 1;
    }
  }
  return reconciled;
}

export function isProjectBusy(projectId: string): boolean {
  return busyProjects.has(projectId);
}

export async function refreshTask(
  projectId: string,
  taskId: string,
): Promise<Task | null> {
  return loadTask(projectId, taskId);
}
