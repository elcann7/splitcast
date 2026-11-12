import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Project } from "../api";
import { useT, errText } from "../i18n";
import { Button } from "../ui/Button";
import { LoadingBlock, StateMessage } from "../ui/States";
import { AnalysisScreen } from "./Analysis";
import { Workspace } from "./workspace/Workspace";
import { navigate, paths } from "../lib/router";

interface Props {
  id: string;
  dialog: "export" | "rescan" | null;
  query: URLSearchParams;
}

/** Loads a project and decides what to show: analysis (nothing ready yet, or failed / cancelled) or the workspace. */
export function ProjectScreen({ id, dialog, query }: Props) {
  const t = useT();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped whenever an answer to a user action lands. A background refresh that was
  // requested before that must not overwrite the newer data.
  const version = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(async () => {
    const v = version.current;
    try {
      const p = await api.getProject(id);
      if (v !== version.current) return;
      setProject(p);
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [id]);

  /** An answer to something the user did (rename, merge, move, ...). */
  const applyMutation = useCallback(
    (p: Project) => {
      version.current++;
      setProject(p);
      setError(null);
      // sources may still be arriving: fetch again shortly so nothing waits for the next poll
      if (p.activeJobId) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(load, 1200);
      }
    },
    [load],
  );

  useEffect(() => {
    load();
    return () => clearTimeout(refreshTimer.current);
  }, [load]);

  if (error && !project) {
    return (
      <StateMessage
        title={t("ws.loadErr")}
        body={error}
        action={
          <>
            <Button onClick={load}>{t("common.retry")}</Button>
            <Button onClick={() => navigate(paths.library())}>{t("analysis.toLibrary")}</Button>
          </>
        }
      />
    );
  }
  if (!project) return <LoadingBlock />;
  if (project.status !== "ready") return <AnalysisScreen project={project} onChanged={load} />;
  return <Workspace project={project} setProject={applyMutation} reload={load} dialog={dialog} query={query} />;
}
