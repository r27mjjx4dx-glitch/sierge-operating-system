import { describe, expect, it } from "vitest";
import {
  decide,
  isInside,
  isSecretPath,
  isSiergeMetadataPath,
  type PolicyContext,
} from "../src/server/policy/rules.js";

const WT = "C:\\Users\\test\\AppData\\Local\\Sierge\\worktrees\\p1\\t1";
const impl: PolicyContext = { worktreePath: WT, phase: "implement" };
const plan: PolicyContext = { worktreePath: WT, phase: "plan" };

const bash = (command: string, ctx: PolicyContext = impl) =>
  decide("Bash", { command }, ctx);

describe("path helpers", () => {
  it("containment is case-insensitive and slash-agnostic", () => {
    expect(isInside(`${WT}\\src\\a.ts`, WT)).toBe(true);
    expect(isInside(WT.toUpperCase() + "/src/a.ts", WT)).toBe(true);
    expect(isInside("C:\\Windows\\system32", WT)).toBe(false);
    // Prefix trickery must not pass: ...\t1-evil is not inside ...\t1
    expect(isInside(WT + "-evil\\x.ts", WT)).toBe(false);
  });

  it("traversal escapes are caught after resolution", () => {
    expect(isInside(`${WT}\\..\\..\\other`, WT)).toBe(false);
  });

  it("secret patterns", () => {
    for (const p of [
      ".env",
      ".env.local",
      "sub\\dir\\.env",
      "key.pem",
      "server.key",
      "id_rsa",
      "credentials.json",
      "secrets.yaml",
      "C:\\Users\\x\\.aws\\config",
      "C:\\Users\\x\\.ssh\\id_ed25519",
    ]) {
      expect(isSecretPath(p), p).toBe(true);
    }
    expect(isSecretPath("src\\envelope.ts")).toBe(false);
    expect(isSecretPath("src\\keyboard.ts")).toBe(false);
  });

  it("sierge metadata patterns", () => {
    expect(isSiergeMetadataPath(`${WT}\\.sierge\\context\\overview.md`)).toBe(true);
    expect(isSiergeMetadataPath("repo/.sierge/decisions.md")).toBe(true);
    expect(isSiergeMetadataPath("src\\sierge.ts")).toBe(false);
  });
});

describe("write tools", () => {
  it("allows writes inside the worktree", () => {
    expect(decide("Write", { file_path: `${WT}\\src\\app.ts` }, impl).action).toBe("allow");
    expect(decide("Edit", { file_path: "src/app.ts" }, impl).action).toBe("allow");
  });

  it("denies writes outside the worktree", () => {
    expect(
      decide("Write", { file_path: "C:\\Windows\\evil.ts" }, impl).action,
    ).toBe("deny");
    expect(decide("Edit", { file_path: "..\\..\\escape.ts" }, impl).action).toBe(
      "deny",
    );
  });

  it("denies writes to .sierge metadata and secrets", () => {
    expect(
      decide("Write", { file_path: ".sierge\\context\\overview.md" }, impl).action,
    ).toBe("deny");
    expect(decide("Write", { file_path: ".env" }, impl).action).toBe("deny");
  });

  it("denies ALL writes during planning", () => {
    expect(decide("Write", { file_path: "src/app.ts" }, plan).action).toBe("deny");
  });
});

describe("read tools", () => {
  it("allows reads inside the worktree", () => {
    expect(decide("Read", { file_path: "src/app.ts" }, impl).action).toBe("allow");
  });
  it("denies secret reads and out-of-worktree reads", () => {
    expect(decide("Read", { file_path: ".env" }, impl).action).toBe("deny");
    expect(
      decide("Read", { file_path: "C:\\Users\\test\\.ssh\\id_rsa" }, impl).action,
    ).toBe("deny");
    expect(
      decide("Read", { file_path: "C:\\Windows\\win.ini" }, impl).action,
    ).toBe("deny");
  });
});

describe("bash hard denies", () => {
  const denied = [
    "git push origin main",
    "git push --force",
    "git merge main",
    "git rebase -i HEAD~3",
    "git tag v1.0",
    "git remote add origin x",
    "git reset --hard HEAD~1",
    "git clean -fd",
    "git branch -D main",
    "git worktree remove x",
    "git config --global user.name evil",
    "npm publish",
    "yarn publish",
    "docker push image",
    "docker login",
    "vercel deploy",
    "netlify deploy",
    "aws s3 rm s3://bucket --recursive",
    "gcloud app deploy",
    "kubectl delete pod x",
    "terraform apply",
    "rm -rf node_modules",
    "rm -fr /",
    "rmdir /s /q dist",
    "rd /s /q dist",
    "del /f /q file.txt",
    "powershell Remove-Item -Recurse -Force dist",
    "format c:",
    "ssh-keygen -t ed25519",
    "ssh-add key",
    "gh auth login",
    "setx PATH evil",
    "reg add HKCU\\evil",
    "shutdown /s",
    "echo hacked > ..\\..\\outside.txt",
    "cat C:\\Windows\\system32\\config\\sam",
    "type C:\\Users\\test\\.aws\\credentials",
    "echo x > .env",
  ];
  for (const cmd of denied) {
    it(`denies: ${cmd}`, () => {
      expect(bash(cmd).action).toBe("deny");
    });
  }

  it("denies chained commands containing a denied segment", () => {
    expect(bash("npm test && git push").action).toBe("deny");
  });
});

describe("bash allowlist", () => {
  const allowed = [
    "npm test",
    "npm run build",
    "npm run lint",
    "npm install",
    "npm ci",
    "npx tsc --noEmit",
    "npx vitest run",
    "node scripts/check.js",
    "git add -A",
    'git commit -m "feat: add form"',
    "git status",
    "git diff",
    "git log --oneline -5",
    "mkdir src\\components",
    "npm run build && npm test",
  ];
  for (const cmd of allowed) {
    it(`allows: ${cmd}`, () => {
      expect(bash(cmd).action).toBe("allow");
    });
  }

  it("denies all bash during planning", () => {
    expect(bash("npm test", plan).action).toBe("deny");
  });
});

describe("bash ask cases", () => {
  const asked = [
    "npm install left-pad",
    "npm i lodash",
    "yarn add react-query",
    "curl https://example.com",
    "wget https://example.com/x",
    "Invoke-WebRequest https://example.com",
    "npx cowsay hi",
    "python script.py",
    "cargo build",
  ];
  for (const cmd of asked) {
    it(`asks: ${cmd}`, () => {
      expect(bash(cmd).action).toBe("ask");
    });
  }
});

describe("PowerShell tool (Windows shell)", () => {
  const ps = (command: string) => decide("PowerShell", { command }, impl);
  it("classifies commands like Bash", () => {
    expect(ps("npm run build").action).toBe("allow");
    expect(ps("git commit -m msg").action).toBe("allow");
    expect(ps("Get-ChildItem -Recurse src").action).toBe("allow");
    expect(ps("Test-Path package.json").action).toBe("allow");
  });
  it("hard-denies dangerous commands", () => {
    expect(ps("Remove-Item -Recurse -Force dist").action).toBe("deny");
    expect(ps("git push").action).toBe("deny");
  });
  it("asks for unclassified commands", () => {
    expect(ps("Invoke-Expression $x").action).toBe("ask");
  });
  it("denies during planning", () => {
    expect(decide("PowerShell", { command: "npm test" }, plan).action).toBe("deny");
  });
});

describe("relative secret references in shell commands", () => {
  it("denies reads of secret files via harmless-looking commands", () => {
    expect(bash("cat .env").action).toBe("deny");
    expect(bash("type .env.local").action).toBe("deny");
    expect(decide("PowerShell", { command: "Get-Content .env" }, impl).action).toBe(
      "deny",
    );
    expect(bash("cat credentials.json").action).toBe("deny");
  });
  it("denies touching .sierge metadata via shell", () => {
    expect(bash("echo x > .sierge/context/overview.md").action).toBe("deny");
    expect(bash("cat .sierge/decisions.md").action).toBe("deny");
  });
  it("still allows normal file arguments", () => {
    expect(bash("cat src/app.ts").action).toBe("allow");
    expect(bash("node scripts/environment-setup.js").action).toBe("allow");
  });
});

describe("other tools", () => {
  it("web tools ask", () => {
    expect(decide("WebFetch", { url: "https://x.com" }, impl).action).toBe("ask");
    expect(decide("WebSearch", { query: "docs" }, impl).action).toBe("ask");
  });
  it("unknown tools ask", () => {
    expect(decide("MysteryTool", {}, impl).action).toBe("ask");
  });
  it("harmless internals allowed", () => {
    expect(decide("TodoWrite", { todos: [] }, impl).action).toBe("allow");
  });
});
