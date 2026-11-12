import { ApiError } from "./types";
import type { Api } from "./types";

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("network", "network");
  }
  if (!res.ok) {
    let code = "http_" + res.status;
    let message = res.statusText || "Request failed";
    try {
      const j = await res.json();
      if (j?.error) {
        code = j.error.code ?? code;
        message = j.error.message ?? message;
      }
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(code, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const enc = encodeURIComponent;
const get = <T,>(u: string) => request<T>("GET", u);
const post = <T,>(u: string, b?: unknown) => request<T>("POST", u, b ?? {});

/** Real HTTP implementation. Every endpoint of ARCHITECTURE.md sections 4 and 7.3. */
export const realApi: Api = {
  mock: false,
  system: () => get("/api/system"),
  downloadModels: (preset, content) => post("/api/models/download", { preset, content }),
  openVideoDialog: () => post("/api/dialog/open-video"),
  chooseFolder: () => post("/api/dialog/choose-folder"),
  probe: (path) => post("/api/probe", { path }),
  listProjects: () => get("/api/projects"),
  createProject: (body) => post("/api/projects", body),
  getProject: (id) => get(`/api/projects/${enc(id)}`),
  renameProject: (id, title) => request("PATCH", `/api/projects/${enc(id)}`, { title }),
  deleteProject: (id) => request("DELETE", `/api/projects/${enc(id)}`),
  rescan: (id, preset) => post(`/api/projects/${enc(id)}/rescan`, { preset }),
  addSources: (id, paths) => post(`/api/projects/${enc(id)}/sources`, { paths }),
  patchSource: (id, sid, body) => request("PATCH", `/api/projects/${enc(id)}/sources/${enc(sid)}`, body),
  deleteSource: (id, sid) => request("DELETE", `/api/projects/${enc(id)}/sources/${enc(sid)}`),
  rescanSource: (id, sid) => post(`/api/projects/${enc(id)}/sources/${enc(sid)}/rescan`),
  patchCharacter: (id, cid, body) => request("PATCH", `/api/projects/${enc(id)}/characters/${enc(cid)}`, body),
  mergeCharacters: (id, body) => post(`/api/projects/${enc(id)}/characters/merge`, body),
  moveAppearances: (id, body) => post(`/api/projects/${enc(id)}/appearances/move`, body),
  previewUrl: (projectId, aid) => `/api/projects/${enc(projectId)}/appearances/${enc(aid)}/preview.mp4`,
  startExport: (id, req) => post(`/api/projects/${enc(id)}/export`, req),
  getJob: (jobId) => get(`/api/jobs/${enc(jobId)}`),
  cancelJob: (jobId) => post(`/api/jobs/${enc(jobId)}/cancel`),
  getSettings: () => get("/api/settings"),
  putSettings: (s) => request("PUT", "/api/settings", s),
  storage: () => get("/api/storage"),
  clearPreviews: () => post("/api/storage/clear-previews"),
  openPath: (path) => post("/api/open-path", { path }),
};
