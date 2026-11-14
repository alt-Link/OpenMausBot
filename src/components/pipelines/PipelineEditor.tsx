import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { PIPELINE_STEPS_MAX, type Pipeline, type PipelineInput } from "../../../shared/pipeline";
import { cn } from "@/lib/cn";
import { intlLocale, t } from "@/lib/i18n";
import { Select } from "../Select";
import { Switch } from "../SettingsPrimitives";

export interface PipelineBot {
  id: string;
  name: string;
  section?: string;
}

type DraftStep = PipelineInput["steps"][number] & { key: string };

const FIELD = "rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent";
const ICON_BUTTON = "flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";
const DAYS = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAYS_ONLY = [1, 2, 3, 4, 5];

let keys = 0;
const keyed = (step: Omit<DraftStep, "key">): DraftStep => ({ ...step, key: `step-${++keys}` });

export function weekdayName(day: number, locale = intlLocale()): string {
  // 2026-11-15 is a Sunday, so adding `day` lands on that weekday.
  return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2026, 10, 15 + day));
}

/** Departments first, in the order bots appear, then bots with none. */
function groupedBots(bots: readonly PipelineBot[]): Array<{ section: string | null; bots: PipelineBot[] }> {
  const groups = new Map<string | null, PipelineBot[]>();
  for (const bot of bots) groups.set(bot.section || null, [...(groups.get(bot.section || null) ?? []), bot]);
  return [...groups.entries()].sort(([a], [b]) => Number(a === null) - Number(b === null)).map(([section, list]) => ({ section, bots: list }));
}

export function PipelineEditor({ pipeline, bots, onSave, onCancel, onDelete }: {
  pipeline?: Pipeline;
  bots: readonly PipelineBot[];
  onSave: (input: PipelineInput) => Promise<string | null>;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(pipeline?.name ?? "");
  const [steps, setSteps] = useState<DraftStep[]>(() => (pipeline?.steps ?? [{ botId: "", instructions: "", review: false }]).map(keyed));
  const [scheduled, setScheduled] = useState(Boolean(pipeline?.schedule));
  const [time, setTime] = useState(pipeline?.schedule?.time ?? "09:00");
  const [weekdays, setWeekdays] = useState<number[]>(pipeline?.schedule?.weekdays ?? WEEKDAYS_ONLY);
  const [scheduledInput, setScheduledInput] = useState(pipeline?.scheduledInput ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const groups = groupedBots(bots);

  const change = (key: string, patch: Partial<DraftStep>) => setSteps((current) => current.map((step) => (step.key === key ? { ...step, ...patch } : step)));
  const move = (index: number, by: number) => setSteps((current) => {
    const next = [...current];
    const [step] = next.splice(index, 1);
    next.splice(index + by, 0, step!);
    return next;
  });
  const toggleDay = (day: number) => setWeekdays((current) => (current.includes(day) ? current.filter((one) => one !== day) : [...current, day]));

  const save = async () => {
    setSaving(true);
    setError(null);
    const problem = await onSave({
      name,
      steps: steps.map(({ key: _key, ...step }) => step),
      schedule: scheduled ? { time, weekdays } : null,
      scheduledInput,
    });
    setSaving(false);
    if (problem) setError(problem);
  };

  return (
    <form className="flex flex-col gap-5" aria-label={pipeline ? t("pipelines.editor.editTitle") : t("pipelines.editor.newTitle")} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-ink-secondary">{t("pipelines.editor.name")}</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("pipelines.editor.namePlaceholder")} maxLength={80} className={FIELD} />
      </label>

      <section aria-label={t("pipelines.editor.steps")} className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold text-ink">{t("pipelines.editor.steps")}</h2>
        <ol className="flex flex-col gap-3">
          {steps.map((step, index) => (
            <li key={step.key} className="rounded-xl border border-hairline/50 bg-card p-3" data-pipeline-step={index + 1}>
              <div className="flex items-center gap-2">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-raised text-[12px] font-semibold text-ink-secondary">{index + 1}</span>
                <Select value={step.botId} onChange={(event) => change(step.key, { botId: event.target.value })} aria-label={t("pipelines.editor.bot", { step: index + 1 })} className="min-w-0 flex-1" size="sm">
                  <option value="">{t("pipelines.editor.chooseBot")}</option>
                  {groups.map((group) => (
                    <optgroup key={group.section ?? ""} label={group.section ?? t("automations.generalDepartment")}>
                      {group.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                    </optgroup>
                  ))}
                </Select>
                <button type="button" className={ICON_BUTTON} disabled={index === 0} onClick={() => move(index, -1)} aria-label={t("pipelines.editor.moveUp", { step: index + 1 })}><ArrowUp size={16} aria-hidden="true" /></button>
                <button type="button" className={ICON_BUTTON} disabled={index === steps.length - 1} onClick={() => move(index, 1)} aria-label={t("pipelines.editor.moveDown", { step: index + 1 })}><ArrowDown size={16} aria-hidden="true" /></button>
                <button type="button" className={ICON_BUTTON} disabled={steps.length === 1} onClick={() => setSteps((current) => current.filter((one) => one.key !== step.key))} aria-label={t("pipelines.editor.remove", { step: index + 1 })}><Trash2 size={16} aria-hidden="true" /></button>
              </div>
              <textarea value={step.instructions} onChange={(event) => change(step.key, { instructions: event.target.value })} rows={3}
                aria-label={t("pipelines.editor.instructions", { step: index + 1 })} placeholder={t("pipelines.editor.instructionsPlaceholder")}
                className={cn(FIELD, "mt-2 w-full resize-y leading-relaxed")} />
              <label className="mt-2 flex items-center justify-between gap-3 text-[13px] text-ink-secondary">
                <span>{t("pipelines.editor.review")}</span>
                <Switch checked={step.review} onClick={() => change(step.key, { review: !step.review })} aria-label={t("pipelines.editor.reviewAria", { step: index + 1 })} />
              </label>
            </li>
          ))}
        </ol>
        <button type="button" className="ui-button ui-button-sm self-start" disabled={steps.length >= PIPELINE_STEPS_MAX}
          onClick={() => setSteps((current) => [...current, keyed({ botId: "", instructions: "", review: false })])}>
          <Plus size={14} aria-hidden="true" />{t("pipelines.editor.addStep")}
        </button>
      </section>

      <section aria-label={t("pipelines.editor.schedule")} className="flex flex-col gap-3">
        <label className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-semibold text-ink">{t("pipelines.editor.schedule")}</span>
          <Switch checked={scheduled} onClick={() => setScheduled((on) => !on)} aria-label={t("pipelines.editor.schedule")} />
        </label>
        {scheduled && (
          <div className="flex flex-col gap-3 rounded-xl border border-hairline/50 bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <input type="time" value={time} onChange={(event) => setTime(event.target.value)} aria-label={t("pipelines.editor.time")} className={cn(FIELD, "[color-scheme:var(--code-color-scheme)]")} />
              <div role="group" aria-label={t("pipelines.editor.days")} className="flex flex-wrap gap-1">
                {DAYS.map((day) => (
                  <button key={day} type="button" aria-pressed={weekdays.includes(day)} onClick={() => toggleDay(day)}
                    className={cn("h-8 min-w-10 rounded-lg px-2 text-[12px] font-medium", weekdays.includes(day) ? "bg-accent/15 text-accent" : "bg-raised text-ink-secondary hover:text-ink")}>
                    {weekdayName(day)}
                  </button>
                ))}
              </div>
            </div>
            <textarea value={scheduledInput} onChange={(event) => setScheduledInput(event.target.value)} rows={2}
              aria-label={t("pipelines.editor.scheduledInput")} placeholder={t("pipelines.editor.scheduledInputPlaceholder")}
              className={cn(FIELD, "w-full resize-y leading-relaxed")} />
          </div>
        )}
      </section>

      {error && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="ui-button ui-button-primary" disabled={saving}>{t("pipelines.editor.save")}</button>
        <button type="button" className="ui-button" onClick={onCancel}>{t("common.cancel")}</button>
        {onDelete && <button type="button" className="ui-button ms-auto text-danger" onClick={onDelete}>{t("pipelines.editor.delete")}</button>}
      </div>
    </form>
  );
}
