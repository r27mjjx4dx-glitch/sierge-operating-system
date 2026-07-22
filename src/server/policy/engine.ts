import crypto from "node:crypto";
import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { decide, type PolicyContext } from "./rules.js";
import { narrate, summarizeInput } from "../agent/narration.js";
import { taskEvents, type TaskRef } from "../events.js";
import { APPROVAL_TIMEOUT_MS } from "../config.js";
import type { PendingApproval } from "../../shared/types.js";

/**
 * The policy engine wires the pure rules into the SDK's permission chain:
 *
 *   PreToolUse hook  — fires FIRST and cannot be bypassed. It (1) appends the
 *                      attempt to the audit log BEFORE any decision and
 *                      (2) enforces hard denies. Everything else is deferred.
 *   canUseTool       — the final gate for anything that needs a decision:
 *                      auto-allow, deny, or a blocking owner approval card
 *                      that times out to DENY.
 *
 * Sierge never uses acceptEdits / bypassPermissions and passes no allow
 * rules, so nothing short-circuits past this engine.
 */

export type ApprovalResolution = {
  resolution: "approved" | "denied" | "answered" | "timeout";
  answer: string | null;
};

interface PendingEntry {
  approval: PendingApproval;
  resolve: (r: ApprovalResolution) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalBroker {
  private pending = new Map<string, PendingEntry>();
  onCreated: ((approval: PendingApproval) => void) | null = null;

  async create(
    ref: TaskRef,
    kind: "tool" | "question",
    title: string,
    detail: string,
    options: string[] | null,
    multiSelect = false,
  ): Promise<ApprovalResolution> {
    const approvalId = crypto.randomUUID();
    const approval: PendingApproval = {
      approvalId,
      taskId: ref.taskId,
      kind,
      title,
      detail,
      options,
      multiSelect,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
    };

    await taskEvents.emit(ref, {
      type: "approval_request",
      taskId: ref.taskId,
      approvalId,
      kind,
      title,
      detail,
      options,
      multiSelect,
    });
    this.onCreated?.(approval);

    return new Promise<ApprovalResolution>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approvalId);
        void taskEvents.emit(ref, {
          type: "approval_resolved",
          taskId: ref.taskId,
          approvalId,
          resolution: "timeout",
          answer: null,
        });
        resolve({ resolution: "timeout", answer: null });
      }, APPROVAL_TIMEOUT_MS);
      this.pending.set(approvalId, { approval, resolve, timer });
    });
  }

  async resolve(
    ref: TaskRef,
    approvalId: string,
    resolution: "approved" | "denied" | "answered",
    answer: string | null,
  ): Promise<boolean> {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    this.pending.delete(approvalId);
    clearTimeout(entry.timer);
    await taskEvents.emit(ref, {
      type: "approval_resolved",
      taskId: ref.taskId,
      approvalId,
      resolution,
      answer,
    });
    entry.resolve({ resolution, answer });
    return true;
  }

  listForTask(taskId: string): PendingApproval[] {
    return [...this.pending.values()]
      .filter((e) => e.approval.taskId === taskId)
      .map((e) => e.approval);
  }
}

export const approvalBroker = new ApprovalBroker();

// ---------------------------------------------------------------------------

export interface GuardConfig {
  ref: TaskRef;
  worktreePath: string;
  phase: PolicyContext["phase"];
}

export interface AgentGuards {
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  canUseTool: CanUseTool;
}

interface QuestionOption {
  label: string;
  description?: string;
}
interface Question {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

function questionsFromInput(input: Record<string, unknown>): Question[] {
  const qs = input.questions;
  if (!Array.isArray(qs)) return [];
  return qs.filter(
    (q): q is Question =>
      typeof q === "object" && q !== null && typeof q.question === "string",
  );
}

export function buildAgentGuards(cfg: GuardConfig): AgentGuards {
  const ctx: PolicyContext = {
    worktreePath: cfg.worktreePath,
    phase: cfg.phase,
  };

  const preToolUse = async (
    input: HookInput,
    _toolUseID: string | undefined,
    _options: { signal: AbortSignal },
  ): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const tool = input.tool_name;
    const toolInput = input.tool_input;

    // 1. AUDIT BEFORE DECIDING — always, for every attempt.
    await taskEvents.emit(cfg.ref, {
      type: "tool_attempt",
      taskId: cfg.ref.taskId,
      phase: cfg.phase,
      tool,
      inputSummary: summarizeInput(toolInput),
      plainSummary: narrate(tool, toolInput, cfg.worktreePath),
    });

    // AskUserQuestion is handled interactively in canUseTool.
    if (tool === "AskUserQuestion") return {};

    // 2. HARD DENIES are enforced here, ahead of every other layer.
    const ruling = decide(tool, toolInput, ctx);
    if (ruling.action === "deny") {
      await taskEvents.emit(cfg.ref, {
        type: "policy_decision",
        taskId: cfg.ref.taskId,
        tool,
        decision: "deny",
        decidedBy: "hard_deny",
        reason: `${ruling.rule}: ${ruling.reason}`,
        plainSummary: `Blocked: ${ruling.reason}`,
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: ruling.reason,
        },
      };
    }

    // Force ask-cases onto the prompt path so no permission mode can
    // auto-allow them past the owner.
    if (ruling.action === "ask") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: ruling.reason,
        },
      };
    }

    // Allow-cases: defer — the decision is made (and logged) downstream.
    return {};
  };

  const canUseTool: CanUseTool = async (
    toolName,
    input,
    _options,
  ): Promise<PermissionResult> => {
    // Clarifying questions -> owner question cards, answered inline.
    if (toolName === "AskUserQuestion") {
      const questions = questionsFromInput(input);
      const answers: Record<string, string> = {};
      for (const q of questions) {
        const res = await approvalBroker.create(
          cfg.ref,
          "question",
          q.question,
          (q.options ?? [])
            .map((o) => `${o.label}${o.description ? ` — ${o.description}` : ""}`)
            .join("\n"),
          (q.options ?? []).map((o) => o.label),
          q.multiSelect ?? false,
        );
        if (res.resolution === "timeout" || res.resolution === "denied") {
          return {
            behavior: "deny",
            message:
              "The owner did not answer in time. Proceed with your most reasonable assumption and state it clearly in the plan.",
          };
        }
        answers[q.question] = res.answer ?? "";
      }
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }

    const ruling = decide(toolName, input, ctx);

    if (ruling.action === "allow") {
      await taskEvents.emit(cfg.ref, {
        type: "policy_decision",
        taskId: cfg.ref.taskId,
        tool: toolName,
        decision: "allow",
        decidedBy: "policy",
        reason: `${ruling.rule}: ${ruling.reason}`,
        plainSummary: narrate(toolName, input, cfg.worktreePath),
      });
      return { behavior: "allow", updatedInput: input };
    }

    if (ruling.action === "deny") {
      await taskEvents.emit(cfg.ref, {
        type: "policy_decision",
        taskId: cfg.ref.taskId,
        tool: toolName,
        decision: "deny",
        decidedBy: "hard_deny",
        reason: `${ruling.rule}: ${ruling.reason}`,
        plainSummary: `Blocked: ${ruling.reason}`,
      });
      return { behavior: "deny", message: ruling.reason };
    }

    // ask -> blocking owner card; timeout defaults to DENY.
    const plain = narrate(toolName, input, cfg.worktreePath);
    const res = await approvalBroker.create(
      cfg.ref,
      "tool",
      `Approval needed: ${plain}`,
      `${ruling.reason}\n\nTechnical detail: ${toolName} ${summarizeInput(input)}`,
      null,
    );

    if (res.resolution === "approved") {
      await taskEvents.emit(cfg.ref, {
        type: "policy_decision",
        taskId: cfg.ref.taskId,
        tool: toolName,
        decision: "ask_allow",
        decidedBy: "owner",
        reason: ruling.reason,
        plainSummary: `Owner approved: ${plain}`,
      });
      return { behavior: "allow", updatedInput: input };
    }

    const timedOut = res.resolution === "timeout";
    await taskEvents.emit(cfg.ref, {
      type: "policy_decision",
      taskId: cfg.ref.taskId,
      tool: toolName,
      decision: timedOut ? "ask_timeout_deny" : "ask_deny",
      decidedBy: timedOut ? "timeout" : "owner",
      reason: ruling.reason,
      plainSummary: timedOut
        ? `No owner response — denied: ${plain}`
        : `Owner declined: ${plain}`,
    });
    return {
      behavior: "deny",
      message: timedOut
        ? "The owner did not respond in time, so this action was denied. Continue without it or finish up."
        : "The owner declined this action. Adjust your approach accordingly.",
    };
  };

  return {
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
    canUseTool,
  };
}
