// A pipeline end to end on the scripted engine: steps run in order in each bot's own thread, a review step holds the run
// until Continue, and the next bot receives the previous bot's result.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import { request } from "../../scripts/mcp-server.ts";

it("runs steps in order, pauses for review, and hands each result on", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? { method } : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const researcher = (await cli("new-bot", "--name", "Researcher")).bot;
    const writer = (await cli("new-bot", "--name", "Scriptwriter")).bot;
    const planPath = join(session.info.dataDir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({
      [researcher.id]: { script: [{ key: "RESEARCH", match: ["Step 1 of 2 of the pipeline"], reply: "ANGLES: tool demos, before/after, price hacks." }] },
      [writer.id]: { script: [{ key: "WRITE", match: ["Step 2 of 2 of the pipeline", "ANGLES: tool demos"], reply: "SCRIPTS: three 30-second scripts." }] },
    }));
    const evidence = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

    const pipeline = await api("/api/pipelines", {
      name: "Weekly shorts",
      steps: [
        { botId: researcher.id, instructions: "Find three trending angles.", review: true },
        { botId: writer.id, instructions: "Write one script per angle.", review: false },
      ],
      schedule: null,
      scheduledInput: "",
    });
    expect(pipeline).toMatchObject({ name: "Weekly shorts", steps: [{ botId: researcher.id }, { botId: writer.id }] });

    const started = await api(`/api/pipelines/${pipeline.id}/run`, { input: "AI video tools" });
    expect(statSync(started.folder).isDirectory()).toBe(true);
    const run = async () => api(`/api/pipeline-runs/${started.id}`, undefined, "GET");

    await expect.poll(async () => (await run()).phase, { timeout: 30_000 }).toBe("waiting");
    const waiting = await run();
    expect(waiting.steps[0]).toMatchObject({ status: "review", output: "ANGLES: tool demos, before/after, price hacks." });
    expect(waiting.steps[1].status).toBe("pending");
    expect(evidence().some((turn) => turn.planKey === "WRITE")).toBe(false);

    const bots = (await api("/api/bots", undefined, "GET")).bots as any[];
    expect(bots.find((bot) => bot.id === researcher.id).tasks.some((task: any) => task.threadId === waiting.steps[0].threadId)).toBe(true);

    expect(await api(`/api/pipeline-runs/${started.id}/continue`, {})).toMatchObject({ current: 1 });
    await expect.poll(async () => (await run()).phase, { timeout: 30_000 }).toBe("done");
    const finished = await run();
    expect(finished.steps.map((step: any) => step.status)).toEqual(["done", "done"]);
    expect(finished.steps[1].output).toBe("SCRIPTS: three 30-second scripts.");
    expect(evidence().some((turn) => turn.planKey === "WRITE")).toBe(true);

    const listed = await api("/api/pipelines", undefined, "GET");
    expect(listed.pipelines).toHaveLength(1);
    expect(listed.runs[0]).toMatchObject({ id: started.id, phase: "done" });

    expect(await api(`/api/pipeline-runs/${started.id}/continue`, {}).catch((error: Error) => error.message)).toContain("isn't waiting");
    expect(await api(`/api/pipelines/${pipeline.id}`, undefined, "DELETE")).toEqual({ ok: true });
    expect((await api("/api/pipelines", undefined, "GET")).pipelines).toEqual([]);
  } finally {
    await session.close();
  }
}, 120_000);
