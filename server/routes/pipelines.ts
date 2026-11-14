import { z } from "zod";

import {
  PIPELINE_INPUT_MAX, PIPELINE_INSTRUCTIONS_MAX, PIPELINE_NAME_MAX, PIPELINE_STEPS_MAX,
  type Pipeline, type PipelineInput, type PipelineRun,
} from "../../shared/pipeline.ts";
import type { PipelineRefusal } from "../pipelines/manager.ts";
import { PASS, type RouteHandler } from "./table.ts";

const stepSchema = z.object({
  id: z.string().max(64).optional(),
  botId: z.string().min(1).max(128),
  instructions: z.string().max(PIPELINE_INSTRUCTIONS_MAX),
  review: z.boolean(),
}).strict();

const pipelineSchema = z.object({
  name: z.string().max(PIPELINE_NAME_MAX * 2),
  steps: z.array(stepSchema).max(PIPELINE_STEPS_MAX * 2),
  schedule: z.object({ time: z.string().max(5), weekdays: z.array(z.number().int()).max(7) }).strict().nullable(),
  scheduledInput: z.string().max(PIPELINE_INPUT_MAX),
}).strict();

const runSchema = z.object({ input: z.string().max(PIPELINE_INPUT_MAX) }).strict();

export interface PipelineRoutesDeps {
  pipelines(): Pipeline[];
  runs(pipelineId?: string): PipelineRun[];
  run(id: string): PipelineRun | undefined;
  create(input: PipelineInput): Pipeline | PipelineRefusal;
  update(id: string, input: PipelineInput): Pipeline | PipelineRefusal;
  remove(id: string): PipelineRefusal | null;
  start(pipelineId: string, input: string): PipelineRun | PipelineRefusal;
  continue(runId: string): PipelineRun | PipelineRefusal;
  stop(runId: string): PipelineRun | PipelineRefusal;
  retry(runId: string): PipelineRun | PipelineRefusal;
}

/** Admin only: these paths are not in CLIENT_ALLOW (server/request-auth.ts). */
export function createPipelineRoutes(deps: PipelineRoutesDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const answer = <T extends object>(result: T | PipelineRefusal, status = 200) =>
      "refused" in result ? json(res, 409, { error: result.refused }) : json(res, status, result);

    if (path === "/api/pipelines") {
      if (method === "GET") return json(res, 200, { pipelines: deps.pipelines(), runs: deps.runs() });
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const parsed = pipelineSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "That pipeline doesn't fit." });
      return answer(deps.create(parsed.data), 201);
    }

    const pipeline = /^\/api\/pipelines\/([\w-]+)(?:\/(run))?$/.exec(path);
    if (pipeline) {
      const [, id, action] = pipeline;
      if (action === "run") {
        if (method !== "POST") return json(res, 405, { error: "method not allowed" });
        const parsed = runSchema.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "That input doesn't fit." });
        return answer(deps.start(id!, parsed.data.input), 201);
      }
      if (method === "PATCH") {
        const parsed = pipelineSchema.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "That pipeline doesn't fit." });
        return answer(deps.update(id!, parsed.data));
      }
      if (method === "DELETE") {
        const refused = deps.remove(id!);
        return refused ? json(res, 404, { error: refused.refused }) : json(res, 200, { ok: true });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    const run = /^\/api\/pipeline-runs\/([\w-]+)(?:\/(continue|stop|retry))?$/.exec(path);
    if (run) {
      const [, id, action] = run;
      if (!action) {
        if (method !== "GET") return json(res, 405, { error: "method not allowed" });
        const found = deps.run(id!);
        return found ? json(res, 200, found) : json(res, 404, { error: "That run is gone." });
      }
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      return answer(deps[action as "continue" | "stop" | "retry"](id!));
    }

    return PASS;
  };
}
