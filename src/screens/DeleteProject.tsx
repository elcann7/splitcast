import { useState } from "react";
import { api } from "../api";
import type { ProjectSummary } from "../api";
import { useT, errWith } from "../i18n";
import { useApp } from "../store/app";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { navigate, paths } from "../lib/router";

/** Button + confirmation for deleting a project, then back to the library. */
export function DeleteProjectButton({ project }: { project: Pick<ProjectSummary, "id" | "title"> }) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        {t("analysis.deleteProject")}
      </Button>
      {open && (
        <Dialog
          title={t("library.deleteTitle")}
          onClose={() => setOpen(false)}
          width={440}
          footer={
            <>
              <Button onClick={() => setOpen(false)} data-autofocus>
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  setOpen(false);
                  try {
                    await api.deleteProject(project.id);
                    navigate(paths.library());
                  } catch (e) {
                    toast("error", errWith(t("ws.actionErr"), e));
                  }
                }}
              >
                {t("common.delete")}
              </Button>
            </>
          }
        >
          <p className="text-fg-2 leading-relaxed">{t("library.deleteBody", { title: project.title })}</p>
        </Dialog>
      )}
    </>
  );
}
