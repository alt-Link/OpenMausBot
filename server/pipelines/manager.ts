// A pipeline run goes one step at a time: a step starts only when the one before it has settled, and a step marked for
// review holds the run until the person presses Continue. Run state lives in the store, so a restart picks up where it was.
import { randomUUID } from "node:crypto";

import {
  PIPELINE_INPUT_MAX, PIPELINE_INSTRUCTIONS_MAX, PIPELINE_NAME_MAX, PIPELINE_STEPS_MAX, PIPELINE_TIME,
  type Pipeline, type PipelineInput, type PipelineRun, type PipelineRunStep, type PipelineSchedule,
} from "../../shared/pipeline.ts";
import { nextOccurrence } from "../routine-schedules.ts";
import type { PipelineStore } from "./store.ts";

const OUTPUT_MAX = 20_000;
const REASON_MAX = 300;
const START_ATTEMPTS = 20;
const TICK_MS = 5_000;
const PRUNE_AFTER_MS = 60 * 24 * 60 * 60_000;
const RUNS_LISTED = 50;

export interface PipelineTurnOutcome {
  ok: boolean;
  text: string;
  /** It stopped to ask the person something in its thread. */
  asked?: boolean;
}

export type PipelineEvent = "review" | "asked" | "failed" | "done";

export interface PipelineManagerDeps {
  store: PipelineStore;
  /** The bot's display name, or undefined when it is gone. */
  botName(botId: string): string | undefined;
  /** Creates the run's shared folder and returns its path. */
  makeFolder(runId: string): string;
  /** Opens the step's thread in its bot's own chat. Null when the bot is gone. */
  openThread(run: PipelineRun, index: number): string | null;
  startStep(run: PipelineRun, index: number, text: string, done: (outcome: PipelineTurnOutcome) => void): Promise<void>;
  stopStep(run: PipelineRun, index: number): void;
  /** The bot's latest reply in that thread: what Continue hands on after the person talked it over with the bot. */
  latestReply(botId: string, threadId: string): string | undefined;
  /** Something the person should hear about happened to a run. */
  announce(run: PipelineRun, event: PipelineEvent): void;
  /** Pipelines or runs changed: clients refetch. */
  changed(): void;
  now?: () => number;
  log?: (line: string) => void;
}

export type PipelineRefusal = { refused: string };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const reasonOf = (text: string, fallback: string) => clip(oneLine(text) || fallback, REASON_MAX);

/** A refusal to start a turn for a reason that passes: the thread is busy or the bot is at its thread limit. */
export const startsLater = (error: unknown): boolean => (error as { status?: number })?.status === 409
  && ["thread_busy", "settling", "thread_limit", "moved"].includes((error as { code?: string }).code ?? "");

export function stepPrompt(run: Pick<PipelineRun, "pipelineName" | "input" | "steps" | "folder">, index: number): string {
  const step = run.steps[index]!;
  const total = run.steps.length;
  const next = run.steps[index + 1];
  const handsTo = next ? `Your final reply is handed to the next step (${next.botName})` : "Your final reply is the pipeline's result";
  const reviewed = step.review ? ", after the person reviews it" : "";
  const parts = [
    `[Step ${index + 1} of ${total} of the pipeline "${oneLine(run.pipelineName)}". Do this step only and end with a clear, complete result. ${handsTo}${reviewed}. Files for this run are shared in ${run.folder}: read earlier steps' files there and save your own there. Do not hand work to other bots or open other threads.]`,
    `Pipeline input:\n${run.input.trim() || "(none)"}`,
    `Your step:\n${step.instructions.trim()}`,
  ];
  const before = run.steps[index - 1];
  if (before) parts.push(`Result of step ${index} (${before.botName}):\n${before.output?.trim() || "(no text result; check the shared folder)"}`);
  return parts.join("\n\n");
}

function cleanSchedule(schedule: PipelineSchedule | null): PipelineSchedule | null | PipelineRefusal {
  if (!schedule) return null;
  const weekdays = [...new Set(schedule.weekdays)].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort();
  if (!PIPELINE_TIME.test(schedule.time)) return { refused: "Choose a time like 09:00." };
  if (weekdays.length === 0) return { refused: "Choose at least one day." };
  return { time: schedule.time, weekdays };
}

export function nextScheduled(pipeline: Pipeline, after: number): number | null {
  if (!pipeline.schedule) return null;
  return nextOccurrence({ type: "daily", time: pipeline.schedule.time, weekdays: pipeline.schedule.weekdays }, Math.max(after, pipeline.scheduledAfter ?? 0));
}

export function createPipelineManager(deps: PipelineManagerDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.error(`pipeline: ${line}`));
  /** Runs whose current step has a start in flight, so a tick never starts it twice. */
  const starting = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function save(run: PipelineRun): PipelineRun {
    store.saveRun(run);
    deps.changed();
    return run;
  }

  function ensureTimer(): void {
    timer ??= setInterval(tick, TICK_MS);
    timer.unref?.();
  }

  function stopIfIdle(): void {
    if (timer && !store.activeRuns().some((run) => run.phase === "running")) { clearInterval(timer); timer = null; }
  }

  function finish(run: PipelineRun, phase: "done" | "failed" | "stopped"): PipelineRun {
    run.phase = phase;
    run.endedAt = now();
    save(run);
    stopIfIdle();
    return run;
  }

  function fail(run: PipelineRun, index: number, reason: string): void {
    const step = run.steps[index]!;
    step.status = "failed";
    step.error = reasonOf(reason, "It could not finish.");
    step.endedAt = now();
    finish(run, "failed");
    deps.announce(run, "failed");
  }

  function begin(runId: string): void {
    const run = store.run(runId);
    if (!run || run.phase !== "running" || starting.has(runId)) return;
    const index = run.current;
    const step = run.steps[index];
    if (!step || step.status !== "queued") return;
    if (!deps.botName(step.botId)) { fail(run, index, "That bot is no longer here."); return; }
    if (!step.threadId) {
      const threadId = deps.openThread(run, index);
      if (!threadId) { fail(run, index, "That bot is no longer here."); return; }
      step.threadId = threadId;
    }
    step.status = "running";
    step.attempts += 1;
    step.startedAt ??= now();
    delete step.error;
    save(run);
    starting.add(runId);
    let ended = false;
    const done = (outcome: PipelineTurnOutcome) => {
      if (ended) return;
      ended = true;
      starting.delete(runId);
      settle(runId, index, outcome);
    };
    deps.startStep(run, index, stepPrompt(run, index), done).catch((error: unknown) => {
      if (ended) return;
      ended = true;
      starting.delete(runId);
      const current = store.run(runId);
      if (!current || current.phase !== "running") return;
      const failed = current.steps[index]!;
      if (startsLater(error) && failed.attempts < START_ATTEMPTS) {
        failed.status = "queued";
        save(current);
        ensureTimer();
        return;
      }
      fail(current, index, error instanceof Error ? error.message : String(error));
    });
  }

  function settle(runId: string, index: number, outcome: PipelineTurnOutcome): void {
    const run = store.run(runId);
    if (!run || run.phase !== "running" || run.current !== index) return;
    const step = run.steps[index]!;
    if (step.status !== "running") return;
    if (outcome.asked) {
      step.status = "asked";
      run.phase = "waiting";
      save(run);
      stopIfIdle();
      deps.announce(run, "asked");
      return;
    }
    if (!outcome.ok || !outcome.text.trim()) { fail(run, index, outcome.text); return; }
    step.output = clip(outcome.text.trim(), OUTPUT_MAX);
    step.endedAt = now();
    if (step.review) {
      step.status = "review";
      run.phase = "waiting";
      save(run);
      stopIfIdle();
      deps.announce(run, "review");
      return;
    }
    step.status = "done";
    advance(run);
  }

  function advance(run: PipelineRun): void {
    if (run.current + 1 >= run.steps.length) {
      finish(run, "done");
      deps.announce(run, "done");
      return;
    }
    run.current += 1;
    run.phase = "running";
    run.steps[run.current]!.status = "queued";
    save(run);
    ensureTimer();
    begin(run.id);
  }

  function tick(): void {
    for (const run of store.activeRuns()) if (run.phase === "running") begin(run.id);
    stopIfIdle();
  }

  function validate(input: PipelineInput): Omit<Pipeline, "id" | "createdAt" | "updatedAt" | "scheduledAfter"> | PipelineRefusal {
    const name = clip(oneLine(input.name), PIPELINE_NAME_MAX);
    if (!name) return { refused: "Give the pipeline a name." };
    if (input.steps.length === 0) return { refused: "Add at least one step." };
    if (input.steps.length > PIPELINE_STEPS_MAX) return { refused: `A pipeline has at most ${PIPELINE_STEPS_MAX} steps.` };
    const steps = [];
    for (const [index, step] of input.steps.entries()) {
      if (!deps.botName(step.botId)) return { refused: `Step ${index + 1} needs a bot.` };
      const instructions = step.instructions.trim();
      if (!instructions) return { refused: `Step ${index + 1} needs instructions.` };
      steps.push({ id: step.id || randomUUID(), botId: step.botId, instructions: instructions.slice(0, PIPELINE_INSTRUCTIONS_MAX), review: step.review });
    }
    const schedule = cleanSchedule(input.schedule);
    if (schedule && "refused" in schedule) return schedule;
    return { name, steps, schedule, scheduledInput: input.scheduledInput.trim().slice(0, PIPELINE_INPUT_MAX) };
  }

  const manager = {
    pipelines(): Pipeline[] {
      return store.pipelines();
    },
    create(input: PipelineInput): Pipeline | PipelineRefusal {
      const fields = validate(input);
      if ("refused" in fields) return fields;
      const at = now();
      const pipeline: Pipeline = { id: randomUUID(), ...fields, ...(fields.schedule ? { scheduledAfter: at } : {}), createdAt: at, updatedAt: at };
      store.savePipeline(pipeline);
      deps.changed();
      return pipeline;
    },
    update(id: string, input: PipelineInput): Pipeline | PipelineRefusal {
      const existing = store.pipeline(id);
      if (!existing) return { refused: "That pipeline is gone." };
      const fields = validate(input);
      if ("refused" in fields) return fields;
      const at = now();
      const rescheduled = JSON.stringify(fields.schedule) !== JSON.stringify(existing.schedule);
      const pipeline: Pipeline = { ...existing, ...fields, updatedAt: at, ...(rescheduled ? { scheduledAfter: at } : {}) };
      store.savePipeline(pipeline);
      deps.changed();
      return pipeline;
    },
    remove(id: string): PipelineRefusal | null {
      if (!store.pipeline(id)) return { refused: "That pipeline is gone." };
      for (const run of store.activeRuns()) if (run.pipelineId === id) manager.stop(run.id);
      store.deletePipeline(id);
      deps.changed();
      return null;
    },
    runs(pipelineId?: string): PipelineRun[] {
      return store.runs(pipelineId, RUNS_LISTED);
    },
    run(id: string): PipelineRun | undefined {
      return store.run(id);
    },
    start(pipelineId: string, input: string, trigger: PipelineRun["trigger"] = "manual"): PipelineRun | PipelineRefusal {
      const pipeline = store.pipeline(pipelineId);
      if (!pipeline) return { refused: "That pipeline is gone." };
      const steps: PipelineRunStep[] = [];
      for (const [index, step] of pipeline.steps.entries()) {
        const botName = deps.botName(step.botId);
        if (!botName) return { refused: `The bot for step ${index + 1} is no longer here. Pick another one.` };
        steps.push({ botId: step.botId, botName, instructions: step.instructions, review: step.review, status: index === 0 ? "queued" : "pending", attempts: 0 });
      }
      const id = randomUUID();
      const run: PipelineRun = {
        id, pipelineId, pipelineName: pipeline.name, input: input.trim().slice(0, PIPELINE_INPUT_MAX), trigger,
        phase: "running", current: 0, steps, folder: deps.makeFolder(id), createdAt: now(),
      };
      save(run);
      ensureTimer();
      begin(id);
      return store.run(id) ?? run;
    },
    /** From a review or a question: hands on the bot's latest reply in that thread and starts the next step. */
    continue(runId: string): PipelineRun | PipelineRefusal {
      const run = store.run(runId);
      if (!run) return { refused: "That run is gone." };
      const step = run.steps[run.current]!;
      if (run.phase !== "waiting" || (step.status !== "review" && step.status !== "asked")) return { refused: "This run isn't waiting for you." };
      const latest = step.threadId ? deps.latestReply(step.botId, step.threadId)?.trim() : undefined;
      const output = latest || step.output;
      if (!output) return { refused: `${step.botName} hasn't replied with a result yet. Answer it in its thread first.` };
      step.output = clip(output, OUTPUT_MAX);
      step.status = "done";
      step.endedAt = now();
      advance(run);
      return store.run(runId) ?? run;
    },
    /** A failed step runs again in a fresh thread. */
    retry(runId: string): PipelineRun | PipelineRefusal {
      const run = store.run(runId);
      if (!run) return { refused: "That run is gone." };
      const step = run.steps[run.current]!;
      if (run.phase !== "failed" || step.status !== "failed") return { refused: "Nothing to retry." };
      const botName = deps.botName(step.botId);
      if (!botName) return { refused: `${step.botName} is no longer here.` };
      step.botName = botName;
      step.status = "queued";
      step.attempts = 0;
      delete step.threadId;
      delete step.error;
      delete step.endedAt;
      delete run.endedAt;
      run.phase = "running";
      save(run);
      ensureTimer();
      begin(runId);
      return store.run(runId) ?? run;
    },
    stop(runId: string): PipelineRun | PipelineRefusal {
      const run = store.run(runId);
      if (!run) return { refused: "That run is gone." };
      if (run.phase !== "running" && run.phase !== "waiting") return run;
      const step = run.steps[run.current]!;
      if (step.status === "running") deps.stopStep(run, run.current);
      for (const each of run.steps) if (each.status !== "done" && each.status !== "failed") each.status = "stopped";
      starting.delete(runId);
      return finish(run, "stopped");
    },
    /** The earliest time a schedule is due, or null. */
    nextDue(): number | null {
      const at = now();
      let soonest: number | null = null;
      for (const pipeline of store.pipelines()) {
        const next = nextScheduled(pipeline, pipeline.scheduledAfter ?? at);
        if (next !== null && (soonest === null || next < soonest)) soonest = next;
      }
      return soonest;
    },
    /** Starts every schedule that is due. A pipeline still running from before skips this turn rather than piling up. */
    runDue(): void {
      const at = now();
      const active = new Set(store.activeRuns().map((run) => run.pipelineId));
      for (const pipeline of store.pipelines()) {
        const next = nextScheduled(pipeline, pipeline.scheduledAfter ?? at);
        if (next === null || next > at) continue;
        store.savePipeline({ ...pipeline, scheduledAfter: at });
        if (active.has(pipeline.id)) { log(`${pipeline.id} skipped a scheduled run: the last one is still going`); continue; }
        const started = manager.start(pipeline.id, pipeline.scheduledInput, "schedule");
        if ("refused" in started) log(`${pipeline.id} could not start on schedule: ${started.refused}`);
      }
      deps.changed();
    },
    /** After a restart: a step that was running lost its turn, so it starts again in the same thread. */
    recover(): void {
      store.prune(now() - PRUNE_AFTER_MS);
      for (const run of store.activeRuns()) {
        const step = run.steps[run.current];
        if (run.phase === "running" && step && step.status === "running") {
          step.status = "queued";
          store.saveRun(run);
        }
      }
      ensureTimer();
      tick();
    },
    close(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return manager;
}

export type PipelineManager = ReturnType<typeof createPipelineManager>;
