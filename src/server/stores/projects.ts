import path from "node:path";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import {
  readJson,
  writeJsonAtomic,
  writeFileAtomic,
  readText,
} from "../fsStore.js";
import { registryPath, defaultProjectsHome } from "../config.js";
import { ensureRepo } from "../gitManager.js";
import type { ContextDoc, ProjectSummary } from "../../shared/types.js";

/**
 * Project registry (machine state, outside any repo) + owner-editable context
 * documents (inside the repo at .sierge/context/, versioned by git).
 * Sierge is the single writer of these files; the agent's policy hard-denies
 * any write to .sierge/**.
 */

interface Registry {
  projects: ProjectSummary[];
}

const CONTEXT_TEMPLATES: Array<{ slug: string; title: string; body: string }> = [
  {
    slug: "overview",
    title: "Product overview",
    body: "# Product overview\n\nDescribe what this product is, who it is for, and what matters most.\n\n_(You can edit this at any time — Claude reads it before planning every change.)_\n",
  },
  {
    slug: "decisions",
    title: "Decisions",
    body: "# Decisions\n\nA running log of product decisions. Sierge appends an entry each time you approve a plan or accept a change.\n",
  },
];

export async function listProjects(): Promise<ProjectSummary[]> {
  const reg = await readJson<Registry>(registryPath, { projects: [] });
  return reg.projects;
}

export async function getProject(id: string): Promise<ProjectSummary | null> {
  return (await listProjects()).find((p) => p.id === id) ?? null;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project"
  );
}

export async function createProject(
  name: string,
  repoPath?: string,
): Promise<ProjectSummary> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Project name is required.");

  const targetPath = path.resolve(
    repoPath?.trim() || path.join(defaultProjectsHome, slugify(trimmed)),
  );

  const existing = await listProjects();
  if (existing.some((p) => path.resolve(p.repoPath) === targetPath)) {
    throw new Error("A project already exists at that folder.");
  }

  const project: ProjectSummary = {
    id: crypto.randomUUID().slice(0, 8),
    name: trimmed,
    repoPath: targetPath,
    createdAt: new Date().toISOString(),
  };

  // Scaffold repo + context docs, then commit so history starts clean.
  await ensureRepo(targetPath);
  const contextDir = path.join(targetPath, ".sierge", "context");
  await fsp.mkdir(contextDir, { recursive: true });
  for (const t of CONTEXT_TEMPLATES) {
    const file = path.join(contextDir, `${t.slug}.md`);
    if ((await readText(file)) === null) {
      await writeFileAtomic(file, t.body);
    }
  }
  const { execa } = await import("execa");
  await execa("git", ["add", "-A"], { cwd: targetPath, windowsHide: true });
  await execa(
    "git",
    ["commit", "-m", "Add Sierge project context", "--allow-empty"],
    { cwd: targetPath, windowsHide: true },
  );

  await writeJsonAtomic(registryPath, {
    projects: [...existing, project],
  } satisfies Registry);
  return project;
}

// ---------------------------------------------------------------------------
// Context docs
// ---------------------------------------------------------------------------

function contextFile(repoPath: string, slug: string): string {
  return path.join(repoPath, ".sierge", "context", `${slug}.md`);
}

const SLUG_RE = /^[a-z0-9-]{1,40}$/;

export async function listContextDocs(
  project: ProjectSummary,
): Promise<ContextDoc[]> {
  const dir = path.join(project.repoPath, ".sierge", "context");
  let entries: string[] = [];
  try {
    entries = (await fsp.readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    entries = [];
  }
  // Overview first, then the rest alphabetically.
  const ordered = entries.sort((a, b) => {
    if (a === "overview.md") return -1;
    if (b === "overview.md") return 1;
    return a.localeCompare(b);
  });
  const docs: ContextDoc[] = [];
  for (const file of ordered) {
    const slug = file.replace(/\.md$/, "");
    const full = path.join(dir, file);
    const body = (await readText(full)) ?? "";
    const stat = await fsp.stat(full);
    docs.push({
      slug,
      title: body.match(/^#\s+(.+)$/m)?.[1] ?? slug,
      body,
      updatedAt: stat.mtime.toISOString(),
    });
  }
  return docs;
}

export async function updateContextDoc(
  project: ProjectSummary,
  slug: string,
  body: string,
): Promise<ContextDoc> {
  if (!SLUG_RE.test(slug)) throw new Error("Invalid context document name.");
  const file = contextFile(project.repoPath, slug);
  await writeFileAtomic(file, body);
  return {
    slug,
    title: body.match(/^#\s+(.+)$/m)?.[1] ?? slug,
    body,
    updatedAt: new Date().toISOString(),
  };
}

export async function appendDecision(
  project: ProjectSummary,
  text: string,
): Promise<void> {
  const file = contextFile(project.repoPath, "decisions");
  const current = (await readText(file)) ?? "# Decisions\n";
  const entry = `\n- **${new Date().toISOString().slice(0, 10)}** — ${text}\n`;
  await writeFileAtomic(file, current + entry);
}

/**
 * Compose the exact context bundle sent to the planning session. What the
 * owner previews in the UI is byte-identical to this string (ADR-0002).
 */
export async function composeContextBundle(
  project: ProjectSummary,
): Promise<string> {
  const docs = await listContextDocs(project);
  const parts = [
    `# Project: ${project.name}`,
    ...docs.map((d) => `\n---\n\n${d.body.trim()}`),
  ];
  return parts.join("\n") + "\n";
}
