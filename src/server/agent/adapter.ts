import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildAgentGuards } from "../policy/engine.js";
import { buildAgentEnv } from "./env.js";
import { taskEvents, type TaskRef } from "../events.js";
import { AGENT_PHASE_TIMEOUT_MS } from "../config.js";

/**
 * The single Claude Agent SDK adapter (ADR-0002). Every agent interaction in
 * Sierge goes through runAgentPhase(); nothing else in the codebase imports
 * the SDK (except the startup self-test). The adapter:
 *
 *  - locks the session to the task worktree (cwd) with settingSources: []
 *    and an explicitly constructed environment;
 *  - installs the policy engine's PreToolUse hook + canUseTool gate;
 *  - streams assistant text to the task's event log / SSE;
 *  - captures session IDs (persisted by the caller for crash recovery)
 *    and cost estimates.
 */

export type AgentPhase = "plan" | "implement" | "summarize";

export interface AgentPhaseInput {
  ref: TaskRef;
  worktreePath: string;
  phase: AgentPhase;
  prompt: string;
  /** Resume an earlier session (must share the same cwd — ADR-0002). */
  resumeSessionId?: string | null;
}

export interface AgentPhaseResult {
  sessionId: string | null;
  finalText: string;
  costUsd: number;
  ok: boolean;
  errorDetail: string | null;
}

const SIERGE_SYSTEM_APPEND = `
You are working inside Sierge, a management layer that lets a non-technical
product owner direct your work. Rules:
- Write ALL owner-facing text in plain language. No jargon, no file-path
  soup, no arrow chains. Explain what things mean for the product.
- Never claim something works unless you verified it in this session.
  Sierge independently runs the project's checks and will show the owner the
  real results, so report honestly.
- Stay strictly inside the task workspace. Never attempt to push, merge,
  deploy, publish, or touch credentials — Sierge blocks these and the
  attempt will be shown to the owner.
- Commit your work with clear messages as you go.`;

export async function runAgentPhase(
  input: AgentPhaseInput,
): Promise<AgentPhaseResult> {
  const guards = buildAgentGuards({
    ref: input.ref,
    worktreePath: input.worktreePath,
    phase: input.phase,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_PHASE_TIMEOUT_MS);

  const isPlan = input.phase === "plan";
  let sessionId: string | null = null;
  let finalText = "";
  let costUsd = 0;
  let ok = false;
  let errorDetail: string | null = null;

  try {
    const q = query({
      prompt: input.prompt,
      options: {
        cwd: input.worktreePath,
        settingSources: [],
        env: buildAgentEnv(),
        includePartialMessages: true,
        abortController: controller,
        permissionMode: isPlan ? "plan" : "default",
        // Plan phase: read-only exploration + clarifying questions.
        tools: isPlan
          ? ["Read", "Glob", "Grep", "AskUserQuestion", "TodoWrite"]
          : { type: "preset", preset: "claude_code" },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: SIERGE_SYSTEM_APPEND,
        },
        hooks: guards.hooks,
        canUseTool: guards.canUseTool,
        ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
      },
    });

    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      } else if (message.type === "stream_event") {
        const event = message.event;
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta" &&
          // Only surface top-level assistant prose, not subagent chatter.
          message.parent_tool_use_id === null
        ) {
          await taskEvents.emit(input.ref, {
            type: "assistant_text",
            taskId: input.ref.taskId,
            phase: input.phase,
            delta: event.delta.text,
          });
        }
      } else if (message.type === "assistant") {
        if (message.parent_tool_use_id === null) {
          const text = message.message.content
            .map((b) =>
              b.type === "text" && "text" in b && typeof b.text === "string"
                ? b.text
                : "",
            )
            .filter(Boolean)
            .join("\n");
          if (text.trim()) finalText = text;
        }
      } else if (message.type === "result") {
        costUsd = message.total_cost_usd ?? 0;
        if (message.subtype === "success") {
          ok = !message.is_error;
          if (message.result?.trim()) finalText = message.result;
          if (!ok) errorDetail = "The session ended with an error result.";
        } else {
          ok = false;
          errorDetail = `Session ended abnormally (${message.subtype}).`;
        }
        if (message.session_id) sessionId = message.session_id;
      }
    }
  } catch (err) {
    ok = false;
    errorDetail = controller.signal.aborted
      ? "The session hit Sierge's time limit and was stopped."
      : `The session failed: ${String(err).slice(0, 300)}`;
  } finally {
    clearTimeout(timeout);
  }

  return { sessionId, finalText, costUsd, ok, errorDetail };
}
