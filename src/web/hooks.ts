import { useEffect, useState } from "react";

export type Route =
  | { name: "projects" }
  | { name: "project"; projectId: string }
  | { name: "task"; taskId: string };

export function parseHash(hash: string): Route {
  const parts = hash
    .replace(/^#/, "")
    .split("/")
    .filter((part) => part.length > 0);
  const head = parts[0];
  const id = parts[1];
  if (head === "project" && id) {
    return { name: "project", projectId: decodeURIComponent(id) };
  }
  if (head === "task" && id) {
    return { name: "task", taskId: decodeURIComponent(id) };
  }
  return { name: "projects" };
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return route;
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}
