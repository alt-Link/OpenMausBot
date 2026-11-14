import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Pipeline, PipelineRun } from "../../../shared/pipeline";
import { PipelineEditor } from "./PipelineEditor";
import { PipelineRunCard } from "./PipelineRunCard";
import { scheduleLine } from "./PipelinesPage";

const run = (patch: Partial<PipelineRun> = {}): PipelineRun => ({
  id: "run-1", pipelineId: "p-1", pipelineName: "Weekly shorts", input: "AI video tools", trigger: "manual",
  phase: "waiting", current: 1, folder: "/data/pipelines/run-1", createdAt: Date.UTC(2026, 10, 16, 9),
  steps: [
    { botId: "r", botName: "Researcher", instructions: "Research.", review: false, status: "done", threadId: "t-1", output: "Three angles", attempts: 1 },
    { botId: "w", botName: "Scriptwriter", instructions: "Write.", review: true, status: "review", threadId: "t-2", output: "Draft scripts", attempts: 1 },
    { botId: "e", botName: "Editor", instructions: "Edit.", review: false, status: "pending", attempts: 0 },
  ],
  ...patch,
});

const card = (value: PipelineRun) => renderToStaticMarkup(createElement(PipelineRunCard, { run: value, open: true, onAct: async () => null, onOpenThread: () => {} }));

describe("pipeline run card", () => {
  it("shows each step's state, its result and Continue while a review waits", () => {
    const html = card(run());
    expect(html).toContain("Waiting for you");
    expect(html.match(/data-step-status="/g)).toHaveLength(3);
    expect(html).toContain('data-step-status="review"');
    expect(html).toContain("Draft scripts");
    expect(html).toContain("Continue");
    expect(html).toContain("Stop");
    expect(html).not.toContain("Retry step");
    expect(html).toContain("Check Scriptwriter&#x27;s result");
    expect(html).toContain("/data/pipelines/run-1");
  });

  it("offers Retry and the reason for a failed step, and no actions once done", () => {
    const failed = run({ phase: "failed", current: 1, steps: [run().steps[0]!, { ...run().steps[1]!, status: "failed", error: "The model is overloaded.", output: undefined }, run().steps[2]!] });
    const html = card(failed);
    expect(html).toContain("Retry step");
    expect(html).toContain("The model is overloaded.");
    expect(html).not.toContain(">Stop<");

    const done = card(run({ phase: "done", current: 2 }));
    expect(done).not.toContain("Continue");
    expect(done).not.toContain("Retry step");
  });
});

describe("pipeline editor", () => {
  const pipeline: Pipeline = {
    id: "p-1", name: "Weekly shorts", createdAt: 1, updatedAt: 1, scheduledInput: "This week's topic",
    schedule: { time: "09:00", weekdays: [1, 3, 5] },
    steps: [
      { id: "s1", botId: "r", instructions: "Find angles.", review: false },
      { id: "s2", botId: "w", instructions: "Write scripts.", review: true },
    ],
  };
  const bots = [{ id: "r", name: "Researcher", section: "Research" }, { id: "w", name: "Scriptwriter", section: "Social Media" }, { id: "g", name: "Moss" }];

  it("lists each step with its bot, grouped by department, and the schedule", () => {
    const html = renderToStaticMarkup(createElement(PipelineEditor, { pipeline, bots, onSave: async () => null, onCancel: () => {}, onDelete: () => {} }));
    expect(html.match(/data-pipeline-step="/g)).toHaveLength(2);
    expect(html).toContain('<optgroup label="Research">');
    expect(html).toContain('<optgroup label="Social Media">');
    expect(html).toContain('<optgroup label="General">');
    expect(html.indexOf('label="General"')).toBeGreaterThan(html.indexOf('label="Social Media"'));
    expect(html).toContain("Find angles.");
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('value="09:00"');
    expect(html).toContain("This week&#x27;s topic");
    expect(html).toContain("Delete pipeline");
  });

  it("starts a new pipeline with one empty step and no schedule", () => {
    const html = renderToStaticMarkup(createElement(PipelineEditor, { bots, onSave: async () => null, onCancel: () => {} }));
    expect(html.match(/data-pipeline-step="/g)).toHaveLength(1);
    expect(html).not.toContain('type="time"');
    expect(html).not.toContain("Delete pipeline");
  });
});

describe("schedule line", () => {
  it("names the days in week order, or every day", () => {
    const base = { id: "p", name: "P", steps: [], scheduledInput: "", createdAt: 1, updatedAt: 1 };
    expect(scheduleLine({ ...base, schedule: null })).toBeNull();
    expect(scheduleLine({ ...base, schedule: { time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } })).toBe("Runs every day at 09:00");
    expect(scheduleLine({ ...base, schedule: { time: "18:30", weekdays: [5, 1] } })).toMatch(/^Runs Mon, Fri at 18:30$/);
  });
});
