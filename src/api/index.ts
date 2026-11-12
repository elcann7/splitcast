import { realApi } from "./client";
import { mockApi } from "./mock";
import type { Api } from "./types";

export const MOCK =
  import.meta.env.VITE_MOCK === "1" || new URLSearchParams(location.search).has("mock");

/** The app only ever talks to this. It does not know whether it is real or mock. */
export const api: Api = MOCK ? mockApi : realApi;

export * from "./types";
