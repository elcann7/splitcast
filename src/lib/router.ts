import { useSyncExternalStore } from "react";

// Hash routes keep the page URL stable (the backend serves one index.html) and
// leave the ?mock=1 query intact.
//   #/                          library
//   #/new?path=<p1>&path=<p2>   library + new-project dialog (one path per video)
//   #/settings
//   #/project/<id>              workspace (or analysis while the project is analysing)
//   #/project/<id>/export       workspace + export dialog

export type Route =
  | { name: "library"; newPaths: string[] }
  | { name: "settings" }
  | { name: "project"; id: string; dialog: "export" | "rescan" | null; query: URLSearchParams };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const [pathPart, q = ""] = raw.split("?");
  const query = new URLSearchParams(q);
  const seg = pathPart.split("/").filter(Boolean);
  if (seg[0] === "settings") return { name: "settings" };
  if (seg[0] === "project" && seg[1]) {
    const d = seg[2] === "export" ? "export" : seg[2] === "rescan" ? "rescan" : null;
    return { name: "project", id: decodeURIComponent(seg[1]), dialog: d, query };
  }
  if (seg[0] === "new") return { name: "library", newPaths: query.getAll("path").filter(Boolean) };
  return { name: "library", newPaths: [] };
}

let cachedHash = "";
let cachedRoute: Route = parseHash("");

function snapshot(): Route {
  if (location.hash !== cachedHash) {
    cachedHash = location.hash;
    cachedRoute = parseHash(cachedHash);
  }
  return cachedRoute;
}

function subscribe(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot);
}

export function navigate(to: string, replace = false) {
  const target = "#" + to;
  if (replace) history.replaceState(null, "", location.pathname + location.search + target);
  else location.hash = target;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export const paths = {
  library: () => "/",
  settings: () => "/settings",
  project: (id: string) => `/project/${encodeURIComponent(id)}`,
  newProject: (ps: string[]) => `/new?${ps.map((p) => `path=${encodeURIComponent(p)}`).join("&")}`,
};
