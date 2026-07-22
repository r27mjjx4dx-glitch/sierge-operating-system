import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { SERVER_HOST, SERVER_PORT, dataRoot, worktreesRoot } from "./config.js";
import { ensureDir, existsSync } from "./fsStore.js";
import { registerRoutes } from "./routes.js";
import { runPreflight } from "./preflight.js";
import { listProjects } from "./stores/projects.js";
import { recoverInterruptedTasks } from "./stores/tasks.js";
import { stopAllPreviews } from "./preview.js";

const app = Fastify({ logger: false });

await ensureDir(dataRoot);
await ensureDir(worktreesRoot);

// Crash recovery: mid-flight tasks are marked failed (honestly), never
// presented as done.
const projects = await listProjects();
const recovered = await recoverInterruptedTasks(projects.map((p) => p.id));
if (recovered > 0) {
  console.log(
    `[sierge] Marked ${recovered} interrupted task(s) as failed after restart (work preserved on their branches).`,
  );
}

await registerRoutes(app);

// Serve the built web UI when present (npm run build); in development the
// Vite dev server (npm run dev) proxies /api here instead.
const webDist = path.resolve(process.cwd(), "dist", "web");
if (existsSync(path.join(webDist, "index.html"))) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith("/api/")) {
      void reply.status(404).send({ error: "Not found." });
    } else {
      void reply.sendFile("index.html");
    }
  });
} else {
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: req.raw.url?.startsWith("/api/")
        ? "Not found."
        : "The web UI is not built yet. Run `npm run dev` for development or `npm run build` first.",
    });
  });
}

const shutdown = async () => {
  await stopAllPreviews().catch(() => {});
  await app.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: SERVER_HOST, port: SERVER_PORT });

const preflight = await runPreflight();
console.log(`\n  Sierge is running at http://${SERVER_HOST}:${SERVER_PORT}\n`);
for (const check of preflight.checks) {
  console.log(`  ${check.ok ? "OK " : "!! "} ${check.name}: ${check.detail}`);
}
console.log(
  `  ${preflight.selfTest.status === "passed" ? "OK " : "-- "} Safety self-test: ${preflight.selfTest.detail}\n`,
);
