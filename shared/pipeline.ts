// Wire types for pipelines: a fixed order of bots, each running one step and handing its result to the next.

export const PIPELINE_NAME_MAX = 80;
export const PIPELINE_STEPS_MAX = 10;
export const PIPELINE_INSTRUCTIONS_MAX = 8_000;
export const PIPELINE_INPUT_MAX = 8_000;

export interface PipelineStep {
  id: string;
  botId: string;
  instructions: string;
  /** The run pauses after this step until the person presses Continue. */
  review: boolean;
}

/** Runs at `time` (24-hour local clock, "HH:MM") on each weekday listed (`0` is Sunday). */
export interface PipelineSchedule {
  time: string;
  weekdays: number[];
}

export interface Pipeline {
  id: string;
  name: string;
  steps: PipelineStep[];
  schedule: PipelineSchedule | null;
  /** The input a scheduled run starts with. */
  scheduledInput: string;
  /** When the schedule last started a run, or when it was set; the next scheduled run comes after this. */
  scheduledAfter?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PipelineInput {
  name: string;
  steps: Array<Omit<PipelineStep, "id"> & { id?: string }>;
  schedule: PipelineSchedule | null;
  scheduledInput: string;
}

export type PipelineRunPhase = "running" | "waiting" | "failed" | "done" | "stopped";

/** `review`: done, waiting for Continue. `asked`: the bot asked the person something in its thread. */
export type PipelineStepStatus = "pending" | "queued" | "running" | "review" | "asked" | "done" | "failed" | "stopped";

export interface PipelineRunStep {
  botId: string;
  botName: string;
  instructions: string;
  review: boolean;
  status: PipelineStepStatus;
  threadId?: string;
  output?: string;
  error?: string;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  pipelineName: string;
  input: string;
  trigger: "manual" | "schedule";
  phase: PipelineRunPhase;
  /** The step the run is on. */
  current: number;
  steps: PipelineRunStep[];
  /** The folder every step of this run shares. */
  folder: string;
  createdAt: number;
  endedAt?: number;
}

export const PIPELINE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
