import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { ContextDoc, Task } from "../../shared/types";
import type { ProjectDetail } from "../../shared/api";
import * as api from "../api";
import { navigate } from "../hooks";
import { btn, Card, ErrorNote, formatDate, inputClass, Spinner, StatusBadge, textareaClass } from "../ui";

export function ProjectHome({ projectId }: { projectId: string }) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"changes" | "notes">("changes");

  useEffect(() => {
    let cancelled = false;
    api
      .getProject(projectId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Couldn't load this project.");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (loadError) {
    return (
      <div>
        <ErrorNote message={loadError} />
        <a href="#/" className="mt-4 inline-block text-sm text-indigo-600 hover:underline">
          Back to your projects
        </a>
      </div>
    );
  }

  if (!detail) {
    return <Spinner label="Loading the project…" />;
  }

  const tabClass = (active: boolean) =>
    `border-b-2 px-1 pb-2 text-sm font-medium transition ${
      active
        ? "border-indigo-600 text-indigo-700"
        : "border-transparent text-slate-500 hover:text-slate-700"
    }`;

  return (
    <div className="space-y-6">
      <div>
        <a href="#/" className="text-sm text-indigo-600 hover:underline">
          &larr; Your projects
        </a>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{detail.name}</h1>
        <p className="mt-1 truncate font-mono text-xs text-slate-400">{detail.repoPath}</p>
      </div>

      <div className="flex gap-6 border-b border-slate-200">
        <button type="button" className={tabClass(tab === "changes")} onClick={() => setTab("changes")}>
          Changes
        </button>
        <button type="button" className={tabClass(tab === "notes")} onClick={() => setTab("notes")}>
          Project notes
        </button>
      </div>

      {tab === "changes" ? (
        <ChangesTab projectId={projectId} tasks={detail.tasks} />
      ) : (
        <NotesTab projectId={projectId} initialDocs={detail.contextDocs} />
      )}
    </div>
  );
}

// --- Changes tab -----------------------------------------------------------

function ChangesTab({ projectId, tasks }: { projectId: string; tasks: Task[] }) {
  const sorted = [...tasks].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return (
    <div className="space-y-6">
      <Composer projectId={projectId} />
      <section>
        <h2 className="mb-3 text-base font-semibold text-slate-900">Past and current changes</h2>
        {sorted.length === 0 ? (
          <p className="text-sm text-slate-500">
            Nothing here yet. Describe your first change above and Claude will get started.
          </p>
        ) : (
          <div className="space-y-3">
            {sorted.map((task) => (
              <a
                key={task.id}
                href={`#/task/${encodeURIComponent(task.id)}`}
                className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900">{task.title}</p>
                  <p className="mt-1 text-xs text-slate-400">{formatDate(task.createdAt)}</p>
                </div>
                <StatusBadge status={task.status} />
              </a>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Composer({ projectId }: { projectId: string }) {
  const [requestText, setRequestText] = useState("");
  const [title, setTitle] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const request = requestText.trim();
    if (!request || sending) return;
    setSending(true);
    setError(null);
    const firstLine = request.split("\n")[0] ?? request;
    const finalTitle = title.trim() || firstLine.slice(0, 60);
    try {
      const task = await api.createTask(projectId, { title: finalTitle, request });
      try {
        await api.startPlan(task.id);
      } catch {
        // The task screen offers a way to start planning if this didn't take.
      }
      navigate(`#/task/${encodeURIComponent(task.id)}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Couldn't send your request.");
      setSending(false);
    }
  };

  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-900">Ask for a change</h2>
      <form onSubmit={(event) => void onSubmit(event)} className="mt-4 space-y-4">
        <div>
          <label htmlFor="change-request" className="mb-1 block text-sm font-medium text-slate-700">
            What would you like to change?
          </label>
          <textarea
            id="change-request"
            className={textareaClass}
            rows={5}
            value={requestText}
            onChange={(event) => setRequestText(event.target.value)}
            placeholder="Describe what you want, in your own words"
          />
        </div>
        <div>
          <label htmlFor="change-title" className="mb-1 block text-sm font-medium text-slate-700">
            Short title (optional)
          </label>
          <input
            id="change-title"
            className={inputClass}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Add an opening-hours page"
          />
        </div>
        <ContextPreviewSection projectId={projectId} />
        <div className="flex items-center gap-3">
          <button type="submit" className={btn.primary} disabled={sending || !requestText.trim()}>
            {sending ? "Sending to Claude…" : "Send to Claude"}
          </button>
          {sending ? <Spinner /> : null}
        </div>
        <ErrorNote message={error} />
      </form>
    </Card>
  );
}

function ContextPreviewSection({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || text !== null) return;
    let cancelled = false;
    api
      .getContextPreview(projectId)
      .then((res) => {
        if (!cancelled) setText(res.text);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load the preview.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, text, projectId]);

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-slate-600 hover:text-slate-800"
        onClick={() => setOpen((o) => !o)}
      >
        What Claude will know about your project
        <span aria-hidden="true" className="text-slate-400">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? (
        <div className="border-t border-slate-200 p-3">
          {error ? <ErrorNote message={error} /> : null}
          {!error && text === null ? <Spinner label="Loading…" /> : null}
          {text !== null ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-slate-600">
              {text}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// --- Project notes tab ------------------------------------------------------

function NotesTab({ projectId, initialDocs }: { projectId: string; initialDocs: ContextDoc[] }) {
  const [docs, setDocs] = useState<ContextDoc[]>(initialDocs);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getContextDocs(projectId)
      .then((fresh) => {
        if (!cancelled) setDocs(fresh);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Couldn't load the notes.");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Claude reads these notes before planning every change. Keep them up to date.
      </p>
      {loadError ? <ErrorNote message={loadError} /> : null}
      {docs.length === 0 && !loadError ? (
        <p className="text-sm text-slate-500">This project doesn't have any notes yet.</p>
      ) : null}
      {docs.map((doc) => (
        <ContextDocCard key={doc.slug} projectId={projectId} doc={doc} />
      ))}
    </div>
  );
}

function ContextDocCard({ projectId, doc }: { projectId: string; doc: ContextDoc }) {
  const [body, setBody] = useState(doc.body);
  const [savedBody, setSavedBody] = useState(doc.body);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = body !== savedBody;

  const onSave = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.saveContextDoc(projectId, doc.slug, body);
      setSavedBody(updated.body);
      setBody(updated.body);
      setJustSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Couldn't save this note.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-900">{doc.title}</h3>
        {justSaved && !dirty ? <span className="text-xs font-medium text-green-600">Saved ✓</span> : null}
        {dirty ? <span className="text-xs text-amber-600">Unsaved changes</span> : null}
      </div>
      <textarea
        className={`${textareaClass} mt-3 font-mono text-xs`}
        rows={8}
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
          setJustSaved(false);
        }}
      />
      <div className="mt-3 flex items-center gap-3">
        <button type="button" className={btn.primary} onClick={() => void onSave()} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <ErrorNote message={error} />
    </Card>
  );
}
