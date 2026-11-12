import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Job } from "../api";

const POLL_MS = 500;

/** Polls GET /api/jobs/{id} every 500 ms until the job is no longer queued/running. */
export function useJob(jobId: string | null) {
  const [job, setJob] = useState<Job | null>(null);
  const [lost, setLost] = useState(false);
  const alive = useRef(0);

  useEffect(() => {
    setJob(null);
    setLost(false);
    if (!jobId) return;
    const token = ++alive.current;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const tick = async () => {
      try {
        const j = await api.getJob(jobId);
        if (alive.current !== token) return;
        failures = 0;
        setLost(false);
        setJob(j);
        if (j.status === "queued" || j.status === "running") timer = setTimeout(tick, POLL_MS);
      } catch {
        if (alive.current !== token) return;
        failures++;
        if (failures >= 3) setLost(true);
        timer = setTimeout(tick, POLL_MS * 2);
      }
    };
    tick();
    return () => {
      alive.current++;
      clearTimeout(timer);
    };
  }, [jobId]);

  return { job, lost, setJob };
}
