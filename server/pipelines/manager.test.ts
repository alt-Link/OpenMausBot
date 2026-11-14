import { afterEach, describe, expect, it } from "vitest";

import type { PipelineInput, PipelineRun } from "../../shared/pipeline.ts";
import { createPipelineManager, nextScheduled, stepPrompt, type PipelineEvent, type PipelineManagerDeps, type PipelineTurnOutcome } from "./manager.ts";
import { openPipelineStore, type PipelineStore } from "./store.ts";

type Started = { run: PipelineRun; index: number; text: string; done: (outcome: PipelineTurnOutcome) => void };

const BOTS: Record<string, string> = { researcher: "Researcher", writer: "Scriptwriter", editor: "Editor" };

function harness(options: { store?: PipelineStore; clock?: { at: number } } = {}) {
  const store = options.store ?? openPipelineStore(":memory:");
  const clock = options.clock ?? { at: Date.UTC(2026, 10, 16, 8, 0) };
  const bots = { ...BOTS };
  const started: Started[] = [];
  const stopped: number[] = [];
  const events: Array<{ event: PipelineEvent; run: PipelineRun }> = [];
  const replies = new Map<string, string>();
  let startError: (() => unknown) | null = null;
  let thread = 0;
  const deps: PipelineManagerDeps = {
    store,
    botName: (botId) => bots[botId],
    makeFolder: (runId) => `/data/pipelines/${runId}`,
    openThread: () => `thread-${++thread}`,
    startStep: async (run, index, text, done) => {
      if (startError) throw startError();
      started.push({ run, index, text, done });
    },
    stopStep: (_run, index) => { stopped.push(index); },
    latestReply: (_botId, threadId) => replies.get(threadId),
    announce: (run, event) => { events.push({ event, run }); },
    changed: () => {},
    now: () => clock.at,
    log: () => {},
  };
  const manager = createPipelineManager(deps);
  return {
    store, manager, started, stopped, events, replies, bots, clock,
    failStartsWith(error: (() => unknown) | null) { startError = error; },
    make(input: Partial<PipelineInput> = {}) {
      const made = manager.create({
        name: "Weekly shorts",
        steps: [
          { botId: "researcher", instructions: "Find three trending angles.", review: false },
          { botId: "writer", instructions: "Write one script per angle.", review: true },
          { botId: "editor", instructions: "Tighten each script.", review: false },
        ],
        schedule: null,
        scheduledInput: "",
        ...input,
      });
      if ("refused" in made) throw new Error(made.refused);
      return made;
    },
    startRun(pipelineId: string, input = "AI video tools") {
      const run = manager.start(pipelineId, input);
      if ("refused" in run) throw new Error(run.refused);
      return run;
    },
  };
}

const ok = (text: string): PipelineTurnOutcome => ({ ok: true, text });
let open: Array<ReturnType<typeof harness>> = [];
const fresh = (options?: Parameters<typeof harness>[0]) => { const one = harness(options); open.push(one); return one; };
afterEach(() => {
  const closing = open;
  open = [];
  for (const one of closing) one.manager.close();
  for (const store of new Set(closing.map((one) => one.store))) store.close();
});

describe("pipeline setup", () => {
  it("refuses a pipeline without a name, steps, a known bot or instructions", () => {
    const { manager } = fresh();
    const step = { botId: "researcher", instructions: "Do it.", review: false };
    expect(manager.create({ name: " ", steps: [step], schedule: null, scheduledInput: "" })).toEqual({ refused: "Give the pipeline a name." });
    expect(manager.create({ name: "P", steps: [], schedule: null, scheduledInput: "" })).toEqual({ refused: "Add at least one step." });
    expect(manager.create({ name: "P", steps: [{ ...step, botId: "ghost" }], schedule: null, scheduledInput: "" })).toEqual({ refused: "Step 1 needs a bot." });
    expect(manager.create({ name: "P", steps: [{ ...step, instructions: "  " }], schedule: null, scheduledInput: "" })).toEqual({ refused: "Step 1 needs instructions." });
    expect(manager.create({ name: "P", steps: Array.from({ length: 11 }, () => step), schedule: null, scheduledInput: "" })).toEqual({ refused: "A pipeline has at most 10 steps." });
  });

  it("refuses a schedule with a bad time or no days", () => {
    const { manager } = fresh();
    const steps = [{ botId: "researcher", instructions: "Do it.", review: false }];
    expect(manager.create({ name: "P", steps, schedule: { time: "9am", weekdays: [1] }, scheduledInput: "" })).toEqual({ refused: "Choose a time like 09:00." });
    expect(manager.create({ name: "P", steps, schedule: { time: "09:00", weekdays: [] }, scheduledInput: "" })).toEqual({ refused: "Choose at least one day." });
  });
});

describe("a pipeline run", () => {
  it("runs one step at a time and hands each result to the next", () => {
    const one = fresh();
    const pipeline = one.make({ steps: [
      { botId: "researcher", instructions: "Find angles.", review: false },
      { botId: "writer", instructions: "Write scripts.", review: false },
    ] });
    const run = one.startRun(pipeline.id);
    expect(one.started).toHaveLength(1);
    expect(one.started[0]!.index).toBe(0);
    expect(one.started[0]!.text).toContain("Pipeline input:\nAI video tools");
    expect(one.started[0]!.text).toContain(`shared in /data/pipelines/${run.id}`);

    one.started[0]!.done(ok("Angle A, angle B"));
    expect(one.started).toHaveLength(2);
    expect(one.started[1]!.index).toBe(1);
    expect(one.started[1]!.text).toContain("Result of step 1 (Researcher):\nAngle A, angle B");

    one.started[1]!.done(ok("Script for A"));
    const finished = one.manager.run(run.id)!;
    expect(finished.phase).toBe("done");
    expect(finished.steps.map((step) => step.status)).toEqual(["done", "done"]);
    expect(one.events.map((event) => event.event)).toEqual(["done"]);
  });

  it("pauses after a review step and hands on the bot's latest reply when the person continues", () => {
    const one = fresh();
    const run = one.startRun(one.make().id);
    one.started[0]!.done(ok("Angles"));
    one.started[1]!.done(ok("First draft"));
    let current = one.manager.run(run.id)!;
    expect(current.phase).toBe("waiting");
    expect(current.steps[1]!.status).toBe("review");
    expect(one.events.map((event) => event.event)).toEqual(["review"]);
    expect(one.started).toHaveLength(2);

    one.replies.set(current.steps[1]!.threadId!, "Second draft, after the person's notes");
    const continued = one.manager.continue(run.id);
    expect("refused" in continued).toBe(false);
    expect(one.started).toHaveLength(3);
    expect(one.started[2]!.text).toContain("Result of step 2 (Scriptwriter):\nSecond draft, after the person's notes");
    current = one.manager.run(run.id)!;
    expect(current.phase).toBe("running");
    expect(current.current).toBe(2);
  });

  it("refuses Continue when the run isn't waiting", () => {
    const one = fresh();
    const run = one.startRun(one.make().id);
    expect(one.manager.continue(run.id)).toEqual({ refused: "This run isn't waiting for you." });
  });

  it("waits on a step that asked the person a question, and continues with the answer it gave after", () => {
    const one = fresh();
    const run = one.startRun(one.make().id);
    one.started[0]!.done({ ok: true, text: "Which platform?", asked: true });
    const waiting = one.manager.run(run.id)!;
    expect(waiting.phase).toBe("waiting");
    expect(waiting.steps[0]!.status).toBe("asked");
    expect(one.events.map((event) => event.event)).toEqual(["asked"]);
    expect(one.manager.continue(run.id)).toEqual({ refused: "Researcher hasn't replied with a result yet. Answer it in its thread first." });

    one.replies.set(waiting.steps[0]!.threadId!, "TikTok angles: A, B");
    one.manager.continue(run.id);
    expect(one.started[1]!.text).toContain("TikTok angles: A, B");
  });

  it("stops at a failed step, and Retry runs only that step again in a fresh thread", () => {
    const one = fresh();
    const run = one.startRun(one.make().id);
    one.started[0]!.done(ok("Angles"));
    one.started[1]!.done({ ok: false, text: "The model is overloaded." });
    const failed = one.manager.run(run.id)!;
    expect(failed.phase).toBe("failed");
    expect(failed.steps[1]).toMatchObject({ status: "failed", error: "The model is overloaded." });
    expect(failed.steps[2]!.status).toBe("pending");
    expect(one.events.map((event) => event.event)).toEqual(["failed"]);

    const firstThread = failed.steps[1]!.threadId;
    one.manager.retry(run.id);
    expect(one.started).toHaveLength(3);
    expect(one.started[2]!.index).toBe(1);
    const retried = one.manager.run(run.id)!;
    expect(retried.phase).toBe("running");
    expect(retried.steps[0]!.status).toBe("done");
    expect(retried.steps[1]!.threadId).not.toBe(firstThread);
  });

  it("treats an empty reply as a failure", () => {
    const one = fresh();
    const run = one.startRun(one.make().id);
    one.started[0]!.done(ok("   "));
    expect(one.manager.run(run.id)!.steps[0]).toMatchObject({ status: "failed", error: "It could not finish." });
  });

  it("stops the running step and ignores its late result", () => {
    const one = fresh();
    const run = one.startRun(one.make().id);
    one.manager.stop(run.id);
    expect(one.stopped).toEqual([0]);
    one.started[0]!.done(ok("Too late"));
    const stopped = one.manager.run(run.id)!;
    expect(stopped.phase).toBe("stopped");
    expect(stopped.steps.every((step) => step.status === "stopped")).toBe(true);
    expect(one.started).toHaveLength(1);
  });

  it("keeps a step queued while its bot is busy and starts it on a later try", () => {
    const one = fresh();
    one.failStartsWith(() => Object.assign(new Error("busy"), { status: 409, code: "thread_limit" }));
    const run = one.startRun(one.make().id);
    return Promise.resolve().then(() => {
      expect(one.manager.run(run.id)!.steps[0]!.status).toBe("queued");
      one.failStartsWith(null);
      one.manager.recover();
      expect(one.started).toHaveLength(1);
      expect(one.manager.run(run.id)!.steps[0]!.status).toBe("running");
    });
  });

  it("fails a step whose start is refused for good", async () => {
    const one = fresh();
    one.failStartsWith(() => new Error("The spend cap is reached."));
    const run = one.startRun(one.make().id);
    await Promise.resolve();
    expect(one.manager.run(run.id)).toMatchObject({ phase: "failed", steps: [{ status: "failed", error: "The spend cap is reached." }, {}, {}] });
  });

  it("fails a run whose bot was removed before its step began", () => {
    const one = fresh();
    const pipeline = one.make();
    const run = one.startRun(pipeline.id);
    delete one.bots.writer;
    one.started[0]!.done(ok("Angles"));
    expect(one.manager.run(run.id)!.steps[1]).toMatchObject({ status: "failed", error: "That bot is no longer here." });
    expect(one.manager.start(pipeline.id, "again")).toEqual({ refused: "The bot for step 2 is no longer here. Pick another one." });
  });

  it("restarts a step whose turn was lost in a restart, in the same thread", () => {
    const store = openPipelineStore(":memory:");
    const first = fresh({ store });
    const run = first.startRun(first.make().id);
    const threadId = first.manager.run(run.id)!.steps[0]!.threadId;
    first.manager.close();

    const second = fresh({ store });
    second.manager.recover();
    expect(second.started).toHaveLength(1);
    expect(second.started[0]!.run.steps[0]!.threadId).toBe(threadId);
    expect(second.manager.run(run.id)!.steps[0]!.attempts).toBe(2);
  });

  it("removes a pipeline's runs with it and stops one in progress", () => {
    const one = fresh();
    const pipeline = one.make();
    const run = one.startRun(pipeline.id);
    expect(one.manager.remove(pipeline.id)).toBeNull();
    expect(one.stopped).toEqual([0]);
    expect(one.manager.run(run.id)).toBeUndefined();
    expect(one.manager.pipelines()).toEqual([]);
  });
});

describe("pipeline schedules", () => {
  it("starts a scheduled run once when due, with the scheduled input, and skips while the last run is going", () => {
    const monday8am = new Date(2026, 10, 16, 8, 0).getTime();
    const clock = { at: monday8am };
    const one = fresh({ clock });
    const pipeline = one.make({ schedule: { time: "09:00", weekdays: [1] }, scheduledInput: "This week's topic" });
    const nineAm = new Date(2026, 10, 16, 9, 0).getTime();
    expect(one.manager.nextDue()).toBe(nineAm);

    clock.at = nineAm + 1_000;
    one.manager.runDue();
    expect(one.started).toHaveLength(1);
    expect(one.started[0]!.run).toMatchObject({ trigger: "schedule", input: "This week's topic" });
    expect(one.manager.nextDue()).toBe(new Date(2026, 10, 23, 9, 0).getTime());

    clock.at = new Date(2026, 10, 23, 9, 0).getTime() + 1_000;
    one.manager.runDue();
    expect(one.started).toHaveLength(1);
    expect(one.manager.runs(pipeline.id)).toHaveLength(1);
  });

  it("has no next run without a schedule", () => {
    const one = fresh();
    expect(nextScheduled(one.make(), Date.now())).toBeNull();
    expect(one.manager.nextDue()).toBeNull();
  });
});

describe("step prompt", () => {
  it("says which step it is, where the files are and who gets the result", () => {
    const run = {
      pipelineName: "Weekly shorts", input: "AI tools", folder: "/f",
      steps: [
        { botId: "a", botName: "Researcher", instructions: "Research.", review: false, status: "done" as const, attempts: 1, output: "Found it" },
        { botId: "b", botName: "Writer", instructions: "Write.", review: true, status: "queued" as const, attempts: 0 },
      ],
    };
    const text = stepPrompt(run, 1);
    expect(text).toContain('Step 2 of 2 of the pipeline "Weekly shorts"');
    expect(text).toContain("Your final reply is the pipeline's result, after the person reviews it.");
    expect(text).toContain("Your step:\nWrite.");
    expect(text).toContain("Result of step 1 (Researcher):\nFound it");
    expect(stepPrompt(run, 0)).toContain("handed to the next step (Writer)");
  });
});
