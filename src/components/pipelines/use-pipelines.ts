import { useCallback, useEffect, useRef, useState } from "react";

import type { Pipeline, PipelineInput, PipelineRun } from "../../../shared/pipeline";
import { listenLiveFrames } from "@/lib/live-events";
import { api, ApiError } from "@/state/api";

export interface PipelinesData {
  pipelines: Pipeline[];
  runs: PipelineRun[];
}

/** The server's words when it refused, or null to show the page's own. */
export function refusalOf(error: unknown): string | null {
  return error instanceof ApiError && typeof error.body?.error === "string" ? error.body.error : null;
}

export function usePipelines() {
  const [data, setData] = useState<PipelinesData | null>(null);
  const [failed, setFailed] = useState(false);
  const loading = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loading.current?.abort();
    const controller = new AbortController();
    loading.current = controller;
    try {
      const next = await api<PipelinesData>("/api/pipelines", { signal: controller.signal });
      if (controller.signal.aborted) return;
      setData(next);
      setFailed(false);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const stop = listenLiveFrames({
      onFrame: (frame) => { if (frame.kind === "pipelines.changed") void load(); },
      onMissedFrames: () => { void load(); },
    });
    return () => { stop(); loading.current?.abort(); };
  }, [load]);

  const send = useCallback(async <T,>(path: string, init: RequestInit): Promise<T> => {
    const result = await api<T>(path, init);
    void load();
    return result;
  }, [load]);

  return {
    data,
    failed,
    reload: load,
    save: (input: PipelineInput, id?: string) =>
      send<Pipeline>(id ? `/api/pipelines/${id}` : "/api/pipelines", { method: id ? "PATCH" : "POST", body: JSON.stringify(input) }),
    remove: (id: string) => send<{ ok: true }>(`/api/pipelines/${id}`, { method: "DELETE" }),
    start: (id: string, input: string) => send<PipelineRun>(`/api/pipelines/${id}/run`, { method: "POST", body: JSON.stringify({ input }) }),
    act: (runId: string, action: "continue" | "stop" | "retry") => send<PipelineRun>(`/api/pipeline-runs/${runId}/${action}`, { method: "POST", body: "{}" }),
  };
}

export type PipelinesApi = ReturnType<typeof usePipelines>;
