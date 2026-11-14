import { useState } from "react";
import { CheckCircle2, Circle, CircleAlert, CircleDot, CirclePause, CircleSlash, LoaderCircle, MessageCircleQuestion } from "lucide-react";

import type { PipelineRun, PipelineRunPhase, PipelineStepStatus } from "../../../shared/pipeline";
import { cn } from "@/lib/cn";
import { intlLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

const PHASE: Record<PipelineRunPhase, { label: LocaleKey; tone: string }> = {
  running: { label: "pipelines.phase.running", tone: "text-accent" },
  waiting: { label: "pipelines.phase.waiting", tone: "text-warning" },
  failed: { label: "pipelines.phase.failed", tone: "text-danger" },
  done: { label: "pipelines.phase.done", tone: "text-success" },
  stopped: { label: "pipelines.phase.stopped", tone: "text-ink-tertiary" },
};

const STATUS: Record<PipelineStepStatus, LocaleKey> = {
  pending: "pipelines.step.pending",
  queued: "pipelines.step.queued",
  running: "pipelines.step.running",
  review: "pipelines.step.review",
  asked: "pipelines.step.asked",
  done: "pipelines.step.done",
  failed: "pipelines.step.failed",
  stopped: "pipelines.step.stopped",
};

function StatusIcon({ status }: { status: PipelineStepStatus }) {
  const props = { size: 16, "aria-hidden": true } as const;
  switch (status) {
    case "done": return <CheckCircle2 {...props} className="shrink-0 text-success" />;
    case "running": return <LoaderCircle {...props} className="shrink-0 animate-spin text-accent motion-reduce:animate-none" />;
    case "queued": return <CircleDot {...props} className="shrink-0 text-accent" />;
    case "review": return <CirclePause {...props} className="shrink-0 text-warning" />;
    case "asked": return <MessageCircleQuestion {...props} className="shrink-0 text-warning" />;
    case "failed": return <CircleAlert {...props} className="shrink-0 text-danger" />;
    case "stopped": return <CircleSlash {...props} className="shrink-0 text-ink-tertiary" />;
    default: return <Circle {...props} className="shrink-0 text-ink-tertiary" />;
  }
}

export function runTime(at: number, locale = intlLocale()): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
}

export function PipelineRunCard({ run, open: startOpen, onAct, onOpenThread }: {
  run: PipelineRun;
  open: boolean;
  onAct: (action: "continue" | "stop" | "retry") => Promise<string | null>;
  onOpenThread: (botId: string, threadId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phase = PHASE[run.phase];
  const current = run.steps[run.current];
  const act = async (action: "continue" | "stop" | "retry") => {
    setBusy(true);
    setError(null);
    const problem = await onAct(action);
    setBusy(false);
    if (problem) setError(problem);
  };

  return (
    <details open={startOpen} className="group rounded-xl border border-hairline/50 bg-card" data-pipeline-run={run.phase}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[13px]">
        <span className={cn("font-medium", phase.tone)}>{t(phase.label)}</span>
        <span className="min-w-0 flex-1 truncate text-ink-secondary">{run.input || t("pipelines.run.noInput")}</span>
        <span className="shrink-0 text-[12px] text-ink-tertiary">
          {run.trigger === "schedule" ? `${t("pipelines.run.scheduled")} · ` : ""}{runTime(run.createdAt)}
        </span>
      </summary>
      <div className="border-t border-hairline/35 px-3 py-3">
        <ol className="flex flex-col gap-2" aria-label={t("pipelines.run.steps")}>
          {run.steps.map((step, index) => (
            <li key={index} className="flex flex-col gap-1.5" data-step-status={step.status}>
              <div className="flex items-center gap-2 text-[13px]">
                <StatusIcon status={step.status} />
                <span className="font-medium text-ink">{index + 1}. {step.botName}</span>
                <span className="text-[12px] text-ink-tertiary">{t(STATUS[step.status])}</span>
                {step.threadId && (
                  <button type="button" className="ms-auto text-[12px] text-accent hover:underline" onClick={() => onOpenThread(step.botId, step.threadId!)}>
                    {t("pipelines.run.openThread")}
                  </button>
                )}
              </div>
              {step.error && <p className="ms-6 text-[12px] text-danger">{step.error}</p>}
              {step.output && (
                <details open={step.status === "review"} className="ms-6">
                  <summary className="cursor-pointer text-[12px] text-ink-secondary">{t("pipelines.run.output")}</summary>
                  <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset px-3 py-2 font-sans text-[12px] leading-relaxed text-ink">{step.output}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>

        {current?.status === "review" && <p role="status" className="mt-3 text-[12px] text-ink-secondary">{t("pipelines.run.reviewHint", { bot: current.botName })}</p>}
        {current?.status === "asked" && <p role="status" className="mt-3 text-[12px] text-ink-secondary">{t("pipelines.run.askedHint", { bot: current.botName })}</p>}
        <p className="mt-3 select-all break-all text-[12px] text-ink-tertiary" title={t("pipelines.run.folder")}>{t("pipelines.run.folderLine", { folder: run.folder })}</p>
        {error && <p role="alert" className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}

        {(run.phase === "waiting" || run.phase === "running" || run.phase === "failed") && (
          <div className="mt-3 flex flex-wrap gap-2">
            {run.phase === "waiting" && <button type="button" className="ui-button ui-button-primary ui-button-sm" disabled={busy} onClick={() => void act("continue")}>{t("pipelines.run.continue")}</button>}
            {run.phase === "failed" && <button type="button" className="ui-button ui-button-primary ui-button-sm" disabled={busy} onClick={() => void act("retry")}>{t("pipelines.run.retry")}</button>}
            {run.phase !== "failed" && <button type="button" className="ui-button ui-button-sm" disabled={busy} onClick={() => void act("stop")}>{t("pipelines.run.stop")}</button>}
          </div>
        )}
      </div>
    </details>
  );
}
