import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readJson, writeJsonAtomic } from "../fsStore.js";
import { selftestCachePath } from "../config.js";
import { buildAgentEnv } from "../agent/env.js";

/**
 * Startup self-test (ADR-0002): before any task may run, assert against the
 * live SDK that a PreToolUse hook fires BEFORE canUseTool for the same tool
 * call. The entire permission architecture depends on that ordering; if an
 * SDK update ever changed it, Sierge must refuse to run tasks rather than
 * run them with a silently weakened guard.
 *
 * The result is cached per SDK version so the (small) live query runs once
 * per upgrade, not on every boot.
 */

export interface SelfTestResult {
  sdkVersion: string;
  status: "passed" | "failed";
  detail: string;
  ranAt: string;
}

async function sdkVersion(): Promise<string> {
  const pkgPath = path.join(
    process.cwd(),
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "package.json",
  );
  const pkg = await readJson<{ version?: string }>(pkgPath, {});
  return pkg.version ?? "unknown";
}

export async function getCachedSelfTest(): Promise<SelfTestResult | null> {
  const cached = await readJson<SelfTestResult | null>(selftestCachePath, null);
  if (!cached) return null;
  const version = await sdkVersion();
  return cached.sdkVersion === version ? cached : null;
}

export async function runSelfTest(): Promise<SelfTestResult> {
  const version = await sdkVersion();
  const order: string[] = [];
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sierge-selftest-"));
  await fsp.writeFile(path.join(tmpDir, "probe.txt"), "sierge self-test probe\n");

  const controller = new AbortController();
  let detail = "";
  let status: SelfTestResult["status"] = "failed";

  try {
    const q = query({
      prompt:
        "Read the file probe.txt in the current directory and report its contents. Do nothing else.",
      options: {
        cwd: tmpDir,
        model: "claude-haiku-4-5",
        maxTurns: 2,
        settingSources: [],
        env: buildAgentEnv(),
        abortController: controller,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name === "PreToolUse") {
                    order.push(`hook:${input.tool_name}`);
                    // Force the prompt path so canUseTool must be consulted.
                    return {
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: "ask",
                        permissionDecisionReason: "self-test",
                      },
                    };
                  }
                  return {};
                },
              ],
            },
          ],
        },
        canUseTool: async (toolName) => {
          order.push(`canUseTool:${toolName}`);
          // Deny and end the probe — we only care about ordering.
          setTimeout(() => controller.abort(), 250);
          return { behavior: "deny", message: "self-test complete" };
        },
      },
    });

    for await (const _message of q) {
      if (order.some((e) => e.startsWith("canUseTool:"))) {
        controller.abort();
        break;
      }
    }
  } catch (err) {
    // AbortError is the expected exit path once ordering has been observed.
    if (!order.some((e) => e.startsWith("canUseTool:"))) {
      detail = `Self-test query failed before observing a tool call: ${String(err)}`;
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  const firstHook = order.findIndex((e) => e.startsWith("hook:"));
  const firstGate = order.findIndex((e) => e.startsWith("canUseTool:"));

  if (firstHook !== -1 && firstGate !== -1 && firstHook < firstGate) {
    status = "passed";
    detail = `PreToolUse hook fired before canUseTool (observed: ${order.join(" -> ")})`;
  } else if (!detail) {
    detail = `Ordering not confirmed (observed: ${order.join(" -> ") || "no tool call observed"})`;
  }

  const result: SelfTestResult = {
    sdkVersion: version,
    status,
    detail,
    ranAt: new Date().toISOString(),
  };
  await writeJsonAtomic(selftestCachePath, result);
  return result;
}

/** Cached result if valid for the installed SDK, else run live. */
export async function ensureSelfTest(): Promise<SelfTestResult> {
  const cached = await getCachedSelfTest();
  if (cached && cached.status === "passed") return cached;
  return runSelfTest();
}
