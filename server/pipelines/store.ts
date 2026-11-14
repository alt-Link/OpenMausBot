import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Pipeline, PipelineRun } from "../../shared/pipeline.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  json TEXT NOT NULL,
  phase TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pipeline_runs_pipeline ON pipeline_runs(pipeline_id, created_at);
CREATE INDEX IF NOT EXISTS pipeline_runs_phase ON pipeline_runs(phase);
`;

export function openPipelineStore(dataDir: string) {
  const file = dataDir === ":memory:" ? ":memory:" : join(dataDir, "pipelines.db");
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
    closeSync(openSync(file, "a", 0o600));
    chmodSync(file, 0o600);
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  const rows = {
    upsertPipeline: db.prepare("INSERT INTO pipelines (id, json, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json"),
    getPipeline: db.prepare("SELECT json FROM pipelines WHERE id = ?"),
    allPipelines: db.prepare("SELECT json FROM pipelines ORDER BY created_at"),
    deletePipeline: db.prepare("DELETE FROM pipelines WHERE id = ?"),
    upsertRun: db.prepare("INSERT INTO pipeline_runs (id, pipeline_id, json, phase, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, phase = excluded.phase"),
    getRun: db.prepare("SELECT json FROM pipeline_runs WHERE id = ?"),
    recentRuns: db.prepare("SELECT json FROM pipeline_runs ORDER BY created_at DESC LIMIT ?"),
    runsOf: db.prepare("SELECT json FROM pipeline_runs WHERE pipeline_id = ? ORDER BY created_at DESC LIMIT ?"),
    activeRuns: db.prepare("SELECT json FROM pipeline_runs WHERE phase IN ('running', 'waiting') ORDER BY created_at"),
    deleteRunsOf: db.prepare("DELETE FROM pipeline_runs WHERE pipeline_id = ?"),
    pruneRuns: db.prepare("DELETE FROM pipeline_runs WHERE phase IN ('done', 'stopped', 'failed') AND created_at < ?"),
  };
  const parse = <T>(row: unknown): T => JSON.parse((row as { json: string }).json) as T;
  return {
    pipelines(): Pipeline[] {
      return rows.allPipelines.all().map(parse<Pipeline>);
    },
    pipeline(id: string): Pipeline | undefined {
      const row = rows.getPipeline.get(id);
      return row ? parse<Pipeline>(row) : undefined;
    },
    savePipeline(pipeline: Pipeline): void {
      rows.upsertPipeline.run(pipeline.id, JSON.stringify(pipeline), pipeline.createdAt);
    },
    deletePipeline(id: string): void {
      db.exec("BEGIN");
      try {
        rows.deleteRunsOf.run(id);
        rows.deletePipeline.run(id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    run(id: string): PipelineRun | undefined {
      const row = rows.getRun.get(id);
      return row ? parse<PipelineRun>(row) : undefined;
    },
    saveRun(run: PipelineRun): void {
      rows.upsertRun.run(run.id, run.pipelineId, JSON.stringify(run), run.phase, run.createdAt);
    },
    runs(pipelineId: string | undefined, limit: number): PipelineRun[] {
      return (pipelineId ? rows.runsOf.all(pipelineId, limit) : rows.recentRuns.all(limit)).map(parse<PipelineRun>);
    },
    activeRuns(): PipelineRun[] {
      return rows.activeRuns.all().map(parse<PipelineRun>);
    },
    prune(before: number): void {
      rows.pruneRuns.run(before);
    },
    close(): void {
      db.close();
    },
  };
}

export type PipelineStore = ReturnType<typeof openPipelineStore>;
