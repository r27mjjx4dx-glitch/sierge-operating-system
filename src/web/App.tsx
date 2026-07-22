import { useHashRoute } from "./hooks";
import { ProjectsHome } from "./screens/ProjectsHome";
import { ProjectHome } from "./screens/ProjectHome";
import { TaskScreen } from "./screens/TaskScreen";

export function App() {
  const route = useHashRoute();
  const widthClass = route.name === "task" ? "max-w-[1100px]" : "max-w-[880px]";
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className={`mx-auto flex items-center px-6 py-3 ${widthClass}`}>
          <a
            href="#/"
            className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900"
          >
            <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full bg-indigo-600" />
            Sierge
          </a>
        </div>
      </header>
      <main className={`mx-auto px-6 py-8 ${widthClass}`}>
        {route.name === "projects" ? <ProjectsHome /> : null}
        {route.name === "project" ? (
          <ProjectHome key={route.projectId} projectId={route.projectId} />
        ) : null}
        {route.name === "task" ? <TaskScreen key={route.taskId} taskId={route.taskId} /> : null}
      </main>
    </div>
  );
}
