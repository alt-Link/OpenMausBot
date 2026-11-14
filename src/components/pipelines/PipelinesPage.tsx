import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Plus, Workflow } from "lucide-react";

import type { Pipeline } from "../../../shared/pipeline";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageActions, ToolPageHeader } from "../ToolPageShell";
import { PipelineEditor, weekdayName, type PipelineBot } from "./PipelineEditor";
import { PipelineRunCard } from "./PipelineRunCard";
import { refusalOf, usePipelines, type PipelinesApi } from "./use-pipelines";

type View = { kind: "list" } | { kind: "edit"; id?: string } | { kind: "pipeline"; id: string };

export function scheduleLine(pipeline: Pipeline): string | null {
  if (!pipeline.schedule) return null;
  const days = pipeline.schedule.weekdays.length === 7 ? t("pipelines.schedule.everyDay") : [1, 2, 3, 4, 5, 6, 0].filter((day) => pipeline.schedule!.weekdays.includes(day)).map((day) => weekdayName(day)).join(", ");
  return t("pipelines.schedule.line", { days, time: pipeline.schedule.time });
}

function Chain({ pipeline, names }: { pipeline: Pipeline; names: Map<string, string> }) {
  return (
    <p className="flex flex-wrap items-center gap-1 text-[12px] text-ink-secondary">
      {pipeline.steps.map((step, index) => (
        <span key={step.id} className="flex items-center gap-1">
          {index > 0 && <ArrowRight size={12} aria-hidden="true" className="text-ink-tertiary" />}
          <span>{names.get(step.botId) ?? t("pipelines.missingBot")}</span>
        </span>
      ))}
    </p>
  );
}

function PipelineDetail({ pipeline, names, pipelines, onEdit }: { pipeline: Pipeline; names: Map<string, string>; pipelines: PipelinesApi; onEdit: () => void }) {
  const { dispatch } = useStore();
  const [input, setInput] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runs = (pipelines.data?.runs ?? []).filter((run) => run.pipelineId === pipeline.id);
  const schedule = scheduleLine(pipeline);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await pipelines.start(pipeline.id, input);
      setInput("");
    } catch (failure) {
      setError(refusalOf(failure) ?? t("pipelines.run.startFailed"));
    }
    setStarting(false);
  };
  const act = async (runId: string, action: "continue" | "stop" | "retry") => {
    try {
      await pipelines.act(runId, action);
      return null;
    } catch (failure) {
      return refusalOf(failure) ?? t("pipelines.run.actionFailed");
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold text-ink">{pipeline.name}</h2>
          <Chain pipeline={pipeline} names={names} />
          {schedule && <p className="mt-1 text-[12px] text-ink-tertiary">{schedule}</p>}
        </div>
        <button type="button" className="ui-button ui-button-sm" onClick={onEdit}>{t("pipelines.edit")}</button>
      </div>

      <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void start(); }}>
        <textarea value={input} onChange={(event) => setInput(event.target.value)} rows={3} aria-label={t("pipelines.run.input")} placeholder={t("pipelines.run.inputPlaceholder")}
          className="w-full resize-y rounded-xl border border-hairline/50 bg-inset px-3.5 py-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent" />
        {error && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}
        <button type="submit" className="ui-button ui-button-primary self-start" disabled={starting}>{t("pipelines.run.start")}</button>
      </form>

      <section aria-label={t("pipelines.runs")} className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-ink">{t("pipelines.runs")}</h3>
        {runs.length === 0 ? <p className="text-[13px] text-ink-tertiary">{t("pipelines.runsEmpty")}</p> : runs.map((run, index) => (
          <PipelineRunCard key={run.id} run={run} open={index === 0 || run.phase === "waiting"} onAct={(action) => act(run.id, action)}
            onOpenThread={(botId, threadId) => dispatch({ type: "switchTask", botId, threadId })} />
        ))}
      </section>
    </div>
  );
}

/** Pipelines: fixed orders of bots, each step handing its result to the next. */
export function PipelinesPage() {
  const { state, dispatch } = useStore();
  const pipelines = usePipelines();
  const [view, setView] = useState<View>({ kind: "list" });
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);

  const bots: PipelineBot[] = useMemo(() => state.bots.filter((bot) => !bot.hidden).map((bot) => ({ id: bot.id, name: bot.name, ...(bot.section ? { section: bot.section } : {}) })), [state.bots]);
  const names = useMemo(() => new Map(bots.map((bot) => [bot.id, bot.name])), [bots]);
  const list = pipelines.data?.pipelines ?? null;
  const selected = view.kind !== "list" && view.id ? list?.find((pipeline) => pipeline.id === view.id) : undefined;
  const goBack = () => {
    if (view.kind === "edit" && view.id) setView({ kind: "pipeline", id: view.id });
    else if (view.kind !== "list") setView({ kind: "list" });
    else dispatch({ type: "showChat" });
  };

  const save = async (input: Parameters<PipelinesApi["save"]>[0]) => {
    try {
      const saved = await pipelines.save(input, view.kind === "edit" ? view.id : undefined);
      setView({ kind: "pipeline", id: saved.id });
      return null;
    } catch (failure) {
      return refusalOf(failure) ?? t("pipelines.editor.saveFailed");
    }
  };
  const remove = async (id: string) => {
    try {
      await pipelines.remove(id);
    } catch { /* the list reloads either way */ }
    setView({ kind: "list" });
  };

  let body;
  if (pipelines.failed && !list) {
    body = (
      <section role="alert" className="px-6 py-16 text-center">
        <p className="text-[14px] text-ink-secondary">{t("pipelines.loadFailed")}</p>
        <button type="button" className="ui-button mt-4" onClick={() => void pipelines.reload()}>{t("common.tryAgain")}</button>
      </section>
    );
  } else if (!list) {
    body = null;
  } else if (view.kind === "edit") {
    body = <PipelineEditor key={view.id ?? "new"} pipeline={selected} bots={bots} onSave={save} onCancel={goBack} {...(selected ? { onDelete: () => void remove(selected.id) } : {})} />;
  } else if (view.kind === "pipeline" && selected) {
    body = <PipelineDetail pipeline={selected} names={names} pipelines={pipelines} onEdit={() => setView({ kind: "edit", id: selected.id })} />;
  } else if (list.length === 0) {
    body = (
      <section aria-label={t("pipelines.empty.title")} className="px-6 py-16 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Workflow size={22} aria-hidden="true" /></div>
        <h2 className="text-[17px] font-semibold text-ink">{t("pipelines.empty.title")}</h2>
        <p className="mx-auto mt-2 max-w-sm text-[14px] leading-relaxed text-ink-secondary">{t("pipelines.empty.body")}</p>
        <button type="button" className="ui-button ui-button-primary mt-4" onClick={() => setView({ kind: "edit" })}>{t("pipelines.new")}</button>
      </section>
    );
  } else {
    const runs = pipelines.data?.runs ?? [];
    body = (
      <ul aria-label={t("pipelines.title")} className="flex flex-col gap-2">
        {list.map((pipeline) => {
          const latest = runs.find((run) => run.pipelineId === pipeline.id);
          const schedule = scheduleLine(pipeline);
          return (
            <li key={pipeline.id}>
              <button type="button" onClick={() => setView({ kind: "pipeline", id: pipeline.id })} className="flex w-full flex-col gap-1 rounded-xl border border-hairline/50 bg-card px-3.5 py-3 text-start hover:bg-raised">
                <span className="flex w-full items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{pipeline.name}</span>
                  {latest?.phase === "waiting" && <span className="text-[12px] font-medium text-warning">{t("pipelines.phase.waiting")}</span>}
                  {latest?.phase === "running" && <span className="text-[12px] font-medium text-accent">{t("pipelines.phase.running")}</span>}
                  {latest?.phase === "failed" && <span className="text-[12px] font-medium text-danger">{t("pipelines.phase.failed")}</span>}
                </span>
                <Chain pipeline={pipeline} names={names} />
                {schedule && <span className="text-[12px] text-ink-tertiary">{schedule}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <ToolPage label={t("pipelines.title")}>
      <ToolPageHeader backLabel={t("automations.back")} onBack={goBack} backRef={back}>
        <h1 className={TOOL_PAGE_TITLE}>{t("pipelines.title")}</h1>
        {view.kind === "list" && list && list.length > 0 && (
          <ToolPageActions>
            <button type="button" className="ui-button ui-button-sm" onClick={() => setView({ kind: "edit" })}><Plus size={14} aria-hidden="true" />{t("pipelines.new")}</button>
          </ToolPageActions>
        )}
      </ToolPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" data-pipelines={list ? list.length : "loading"}>
        <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">{body}</div>
      </div>
    </ToolPage>
  );
}
