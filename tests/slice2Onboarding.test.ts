import { beforeAll, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

// Slice 2: adopting a real, existing repository — default-branch awareness,
// dirty-tree refusal, git-identity preservation. Set the data root before
// importing config-dependent modules.
let git: typeof import("../src/server/gitManager.js");
let projects: typeof import("../src/server/stores/projects.js");

beforeAll(async () => {
  process.env.SIERGE_DATA_DIR = await fsp.mkdtemp(
    path.join(os.tmpdir(), "sierge-slice2-data-"),
  );
  git = await import("../src/server/gitManager.js");
  projects = await import("../src/server/stores/projects.js");
});

/** A pre-existing repo on a non-`main` default branch with real content. */
async function existingRepoOnBranch(branch: string): Promise<string> {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "sierge-existing-"));
  await execa("git", ["init", "-b", branch], { cwd: repo });
  await execa("git", ["config", "user.name", "Real Owner"], { cwd: repo });
  await execa("git", ["config", "user.email", "owner@example.com"], { cwd: repo });
  await fsp.writeFile(path.join(repo, "app.js"), "console.log('real');\n");
  await execa("git", ["add", "-A"], { cwd: repo });
  await execa("git", ["commit", "-m", "existing work"], { cwd: repo });
  return repo;
}

describe("default-branch detection", () => {
  it("detects master / develop, not just main", async () => {
    const master = await existingRepoOnBranch("master");
    expect(await git.detectDefaultBranch(master)).toBe("master");
    const develop = await existingRepoOnBranch("develop");
    expect(await git.detectDefaultBranch(develop)).toBe("develop");
  });
});

describe("adopting an existing repo (createProject)", () => {
  it("records the real default branch and marks it adopted", async () => {
    const repo = await existingRepoOnBranch("master");
    const p = await projects.createProject("Real App", repo);
    expect(p.defaultBranch).toBe("master");
    expect(p.adopted).toBe(true);
  });

  it("does NOT overwrite the owner's git identity", async () => {
    const repo = await existingRepoOnBranch("main");
    await projects.createProject("Keep Identity", repo);
    const name = (await execa("git", ["config", "user.name"], { cwd: repo })).stdout;
    const email = (await execa("git", ["config", "user.email"], { cwd: repo })).stdout;
    expect(name).toBe("Real Owner");
    expect(email).toBe("owner@example.com");
  });

  it("attributes its own setup commit to Sierge, not the owner", async () => {
    const repo = await existingRepoOnBranch("main");
    await projects.createProject("Sierge Author", repo);
    const author = (
      await execa("git", ["log", "-1", "--format=%an <%ae>"], { cwd: repo })
    ).stdout;
    expect(author).toBe("Sierge <sierge@localhost>");
  });

  it("commits ONLY .sierge, leaving untracked and modified files untouched", async () => {
    const repo = await existingRepoOnBranch("main");
    // An untracked file and an unstaged modification the owner hasn't committed.
    await fsp.writeFile(path.join(repo, "scratch.txt"), "not committed\n");
    await fsp.writeFile(path.join(repo, "app.js"), "console.log('local edit');\n");
    await projects.createProject("Scoped Commit", repo);
    const lastCommitFiles = (
      await execa("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: repo })
    ).stdout;
    expect(lastCommitFiles).toContain(".sierge/");
    expect(lastCommitFiles).not.toContain("scratch.txt");
    expect(lastCommitFiles).not.toContain("app.js");
    // The owner's untracked + modified files are preserved, not swept in.
    const status = (await execa("git", ["status", "--porcelain"], { cwd: repo })).stdout;
    expect(status).toContain("scratch.txt");
    expect(status).toContain("app.js");
  });

  it("REFUSES to adopt a repo with STAGED (index) changes", async () => {
    const repo = await existingRepoOnBranch("main");
    await fsp.writeFile(path.join(repo, "app.js"), "console.log('edited');\n");
    await execa("git", ["add", "app.js"], { cwd: repo }); // owner pre-staged work
    await expect(projects.createProject("Staged Repo", repo)).rejects.toThrow(
      /staged/i,
    );
  });
});

describe("full worktree + merge cycle on a non-main branch", () => {
  it("creates a worktree off master, diffs against it, and merges back", async () => {
    const repo = await existingRepoOnBranch("master");
    const proj = await projects.createProject("Cycle App", repo);
    expect(proj.defaultBranch).toBe("master");

    const wt = await git.createTaskWorktree(
      repo,
      proj.id,
      "task1",
      proj.defaultBranch,
    );
    // Make a change on the task branch.
    await fsp.writeFile(path.join(wt.worktreePath, "feature.js"), "// new\n");
    await execa("git", ["add", "-A"], { cwd: wt.worktreePath });
    await execa("git", ["commit", "-m", "add feature"], { cwd: wt.worktreePath });

    const changes = await git.changedFiles(repo, wt.branchName, proj.defaultBranch);
    expect(changes.map((c) => c.path)).toContain("feature.js");

    const sha = await git.mergeTask(
      repo,
      wt.branchName,
      "Accept task1",
      proj.defaultBranch,
    );
    expect(sha).toBeTruthy();
    // The merge landed on master, attributed to Sierge.
    const author = (
      await execa("git", ["log", "-1", "--format=%an", "master"], { cwd: repo })
    ).stdout;
    expect(author).toBe("Sierge");
    expect(fs.existsSync(path.join(repo, "feature.js"))).toBe(true);
    // master is still the checked-out branch.
    expect(await git.detectDefaultBranch(repo)).toBe("master");
  });
});

describe("creating a brand-new project still works (main)", () => {
  it("initializes main and records it", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sierge-new-"));
    const target = path.join(dir, "fresh");
    const p = await projects.createProject("Fresh One", target);
    expect(p.defaultBranch).toBe("main");
    expect(p.adopted).toBe(false);
    expect(fs.existsSync(path.join(target, ".sierge", "context", "overview.md"))).toBe(
      true,
    );
  });
});
