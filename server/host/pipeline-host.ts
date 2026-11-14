// Pipeline steps are ordinary threads of each step's bot, started through the same turn start any turn uses, so a step
// gets the budget check, approvals and every other guard of a normal turn.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Notification, NotifyKind } from "../../shared/notification.ts";
import type { PipelineRun } from "../../shared/pipeline.ts";
import { redactSecretsInText } from "../../shared/redact.ts";
import type { HostTurnResult } from "../coordinator.ts";
import { summarize } from "../notify.ts";
import { quoteInNote, type WorkOrigin } from "../peer-provenance.ts";
import { createPipelineManager, type PipelineEvent, type PipelineManager, type PipelineTurnOutcome } from "../pipelines/manager.ts";
import { openPipelineStore } from "../pipelines/store.ts";
import { serverLine, type ServerLineKey } from "../server-lines.ts";
import type { Store } from "../store.ts";

const TITLE_MAX = 60;
const ORIGIN_QUOTE_MAX = 400;

export interface PipelineTurnOptions {
  threadId: string;
  origin: WorkOrigin;
  allowRoomTurnElsewhere: true;
  onSettled: (outcome: HostTurnResult) => void;
  onDispatchError: (message: string) => void;
}

export interface PipelineHostDeps {
  dataDir: string;
  store: Pick<Store, "bot" | "createTask" | "activePath">;
  language(threadId: string): string | undefined;
  startTurn(botId: string, text: string, opts: PipelineTurnOptions): Promise<unknown>;
  stop(botId: string, threadId: string, cause: string): void;
  changed(): void;
  route(notification: Notification): Notification | null;
  announce(notification: Notification): void;
  log?: (line: string) => void;
}

const EVENTS: Record<PipelineEvent, { kind: NotifyKind; title: ServerLineKey }> = {
  review: { kind: "question", title: "server.pipeline.review" },
  asked: { kind: "question", title: "server.pipeline.asked" },
  failed: { kind: "turn-failed", title: "server.pipeline.failed" },
  done: { kind: "done", title: "server.pipeline.done" },
};

const outcomeOf = (result: HostTurnResult): PipelineTurnOutcome => ({ ok: result.ok && !result.stalled, text: result.text, asked: Boolean(result.cards?.ids.length) });

export function createPipelineHost(deps: PipelineHostDeps): PipelineManager {
  const { store } = deps;
  const root = join(deps.dataDir, "pipelines");

  function notification(run: PipelineRun, event: PipelineEvent): Notification | null {
    const step = run.steps[run.current];
    if (!step?.threadId) return null;
    const bot = store.bot(step.botId);
    if (!bot || bot.notifications === false) return null;
    const language = deps.language(step.threadId);
    const { kind, title } = EVENTS[event];
    const detail = event === "failed" ? step.error ?? "" : event === "asked" ? "" : step.output ?? "";
    return {
      kind, botId: bot.id, botName: bot.name, threadId: step.threadId,
      title: serverLine(language, title, { pipeline: run.pipelineName, step: run.current + 1, bot: step.botName }),
      body: summarize(redactSecretsInText(detail)) || serverLine(language, "server.pipeline.openPage"),
      ...(bot.avatarUrl ? { avatarUrl: bot.avatarUrl } : {}),
    };
  }

  return createPipelineManager({
    store: openPipelineStore(deps.dataDir),
    botName: (botId) => store.bot(botId)?.name,
    makeFolder(runId) {
      const folder = join(root, runId);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      return folder;
    },
    openThread(run, index) {
      const step = run.steps[index]!;
      const bot = store.bot(step.botId);
      if (!bot) return null;
      const title = `${run.pipelineName} · ${index + 1}/${run.steps.length}`.slice(0, TITLE_MAX);
      // A bot with its own project folder keeps it; the prompt names the run's folder either way.
      const task = store.createTask(bot.id, title, false, undefined, undefined, undefined, undefined, bot.cwd ? undefined : run.folder);
      return task?.threadId ?? null;
    },
    startStep(run, index, text, done) {
      const step = run.steps[index]!;
      return deps.startTurn(step.botId, text, {
        threadId: step.threadId!,
        origin: { kind: "user", request: quoteInNote(run.input || run.pipelineName, ORIGIN_QUOTE_MAX) },
        allowRoomTurnElsewhere: true,
        onSettled: (result) => { done(outcomeOf(result)); },
        onDispatchError: (message) => { done({ ok: false, text: message }); },
      }).then(() => undefined);
    },
    stopStep(run, index) {
      const step = run.steps[index]!;
      if (step.threadId) deps.stop(step.botId, step.threadId, "The person stopped this pipeline.");
    },
    latestReply(_botId, threadId) {
      return store.activePath(threadId).findLast((line) => line.role === "bot" && line.kind === "text" && Boolean(line.text?.trim()))?.text;
    },
    announce(run, event) {
      const made = notification(run, event);
      const routed = made ? deps.route(made) : null;
      if (routed) deps.announce(routed);
    },
    changed: deps.changed,
    ...(deps.log ? { log: deps.log } : {}),
  });
}
