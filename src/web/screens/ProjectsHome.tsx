import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { PreflightReport, ProjectSummary } from "../../shared/types";
import * as api from "../api";
import { navigate } from "../hooks";
import { btn, Card, ErrorNote, inputClass, Spinner, formatDate } from "../ui";

export function ProjectsHome() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listProjects()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Couldn't load your projects.");
      });
    api
      .getPreflight()
      .then((report) => {
        if (!cancelled) setPreflight(report);
      })
      .catch(() => {
        // If preflight itself is unreachable, the project list error covers it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Sierge</h1>
        <p className="mt-1 text-sm text-slate-500">
          Describe a change in your own words. Claude plans it, you approve it, and nothing becomes
          part of your project until you say so.
        </p>
      </div>

      <PreflightBanner report={preflight} />

      <section>
        <h2 className="mb-3 text-base font-semibold text-slate-900">Your projects</h2>
        {loadError ? <ErrorNote message={loadError} /> : null}
        {!loadError && projects === null ? <Spinner label="Loading your projects…" /> : null}
        {projects !== null && projects.length === 0 ? (
          <p className="text-sm text-slate-500">
            No projects yet. Create your first one below — it only takes a moment.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {(projects ?? []).map((project) => (
            <a
              key={project.id}
              href={`#/project/${encodeURIComponent(project.id)}`}
              className="block rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-indigo-300 hover:shadow"
            >
              <p className="font-medium text-slate-900">{project.name}</p>
              <p className="mt-1 truncate font-mono text-xs text-slate-400">{project.repoPath}</p>
              <p className="mt-2 text-xs text-slate-400">Created {formatDate(project.createdAt)}</p>
            </a>
          ))}
        </div>
      </section>

      <NewProjectForm />
    </div>
  );
}

function PreflightBanner({ report }: { report: PreflightReport | null }) {
  if (!report) return null;
  const failing = report.checks.filter((check) => !check.ok);
  const selfTestFailed = report.selfTest.status === "failed";
  if (failing.length === 0 && !selfTestFailed) return null;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
      <p className="font-medium text-amber-900">Before you start, a few things need attention</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800">
        {failing.map((check) => (
          <li key={check.name}>{check.detail}</li>
        ))}
        {selfTestFailed ? <li>Sierge's safety self-check didn't pass: {report.selfTest.detail}</li> : null}
      </ul>
      <p className="mt-2 text-sm text-amber-800">
        Sierge may not work properly until these are sorted out.
      </p>
    </div>
  );
}

function NewProjectForm() {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const body = repoPath.trim()
        ? { name: name.trim(), repoPath: repoPath.trim() }
        : { name: name.trim() };
      const created = await api.createProject(body);
      navigate(`#/project/${encodeURIComponent(created.id)}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Couldn't create the project.");
      setCreating(false);
    }
  };

  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-900">New project</h2>
      <form onSubmit={(event) => void onSubmit(event)} className="mt-4 space-y-4">
        <div>
          <label htmlFor="project-name" className="mb-1 block text-sm font-medium text-slate-700">
            Project name
          </label>
          <input
            id="project-name"
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. My bakery website"
          />
        </div>
        <div>
          <label htmlFor="project-path" className="mb-1 block text-sm font-medium text-slate-700">
            Folder on this computer (optional)
          </label>
          <input
            id="project-path"
            className={inputClass}
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
            placeholder="C:\Users\you\my-project"
          />
          <p className="mt-1 text-xs text-slate-500">
            Point this at a project you already have to open it, or leave it
            empty and Sierge will create a new folder for you. If you point at
            an existing project, commit or put aside any staged changes first —
            Sierge won't touch your in-progress work.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className={btn.primary} disabled={creating || !name.trim()}>
            {creating ? "Creating…" : "Create project"}
          </button>
          {creating ? <Spinner /> : null}
        </div>
        <ErrorNote message={error} />
      </form>
    </Card>
  );
}
