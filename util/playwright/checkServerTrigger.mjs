// Browser check: a manual trigger (`risu-trigger` with `risu-id`) in a character's greeting runs on
// the server as a `command` job: the browser posts the job, the trigger's alert and question appear
// and are answered in the UI, its chat changes (with `{{trigger_id}}`) show and are stored, and
// they survive a reload; `/trigger name` typed in the chat input runs on the server too.
//
// Usage: node util/playwright/checkServerTrigger.mjs [--base <url> --password <pw>] (production: the built app,
// e.g. the Docker image on a fresh volume; the check sets its password)
import { randomUUID } from "node:crypto";
import { chatBindingFixture } from "./modelProfiles.mjs";
import { chromium } from "playwright-core";
import { chromePath, isolateContext, openCharacterChat, startStack, unexpectedEgress } from "./stack.mjs";

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)?.slice(0, 1500)}`}`);
};
const v = (value) => ({ value, valueType: "value" });
const TRIGGERS = [
    {
        comment: "go",
        type: "manual",
        conditions: [],
        effect: [
            { type: "v2ShowAlert", indent: 0, ...v("hello from the trigger") },
            { type: "v2GetAlertInput", indent: 0, display: "Who clicked?", displayType: "value", outputVar: "name" },
            { type: "v2Impersonate", indent: 0, role: "char", ...v("trigger says {{getvar::name}} id={{trigger_id}}") },
            { type: "v2Impersonate", indent: 0, role: "char", ...v("second message") },
            { type: "v2ModifyChat", indent: 0, index: "1", indexType: "value", ...v("second edited") },
        ],
    },
    {
        comment: "typed",
        type: "manual",
        conditions: [],
        effect: [{ type: "v2Impersonate", indent: 0, role: "char", ...v("typed trigger ran") }],
    },
];

const args = process.argv.slice(2);
const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
// `--base <url> --password <pw>`: a server already running the built app (e.g. the Docker image).
const stack = option("--base")
    ? null
    : await startStack({
          serverPort: 6199,
          vitePort: 5299,
          // `DEBUG=1`: the server's script and generation lines.
          log: process.env.DEBUG
              ? (text) => /\[(Lua|Generation|LLM)\]/.test(text) && process.stderr.write(text)
              : undefined,
      });
const base = option("--base") ?? stack.baseURL;
const password = option("--password") ?? "playwright";
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
    const run = async () => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        // Only the app and the local mocks: anything else is refused and counted (`stack.mjs`).
        const blocked = await isolateContext(context);
        const page = await context.newPage();
        const pageErrors = [];
        page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
        const frames = [];
        page.on("websocket", (ws) => {
            if (!ws.url().includes("/api/generations/")) return;
            frames.push("open " + new URL(ws.url()).pathname);
            ws.on("framereceived", (f) => frames.push("in " + String(f.payload).slice(0, 2000)));
            ws.on("framesent", (f) => frames.push("out " + String(f.payload).slice(0, 200)));
            ws.on("close", () => frames.push("close"));
        });
        const consoleLines = [];
        page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text().slice(0, 300)}`));
        const requests = [];
        page.on("request", (r) => requests.push({ method: r.method(), url: r.url(), body: r.postData() ?? "" }));
        let auth = null;
        let epoch = null;
        page.on("request", (r) => {
            const h = r.headers();
            if (h["risu-auth"]) auth = h["risu-auth"];
            if (h["x-resource-epoch"]) epoch = h["x-resource-epoch"];
        });
        page.on("response", (r) => {
            const e = r.headers()["x-resource-epoch"];
            if (e) epoch = e;
        });
        const open = async () => {
            auth = null;
            await page.goto(base);
            for (let i = 0; i < 240; i++) {
                const input = page.locator("input:visible").first();
                const ok = page.getByRole("button", { name: "OK", exact: true });
                if ((await ok.count()) > 0 && (await input.count()) > 0) {
                    await input.fill(password);
                    await ok.first().click();
                }
                if (auth && (await ok.count()) === 0) {
                    await page.waitForTimeout(2500);
                    return;
                }
                await page.waitForTimeout(500);
            }
            throw new Error("the app did not load");
        };
        const api = async (p, init = {}) => {
            const r = await fetch(base + p, {
                ...init,
                headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
            });
            return { status: r.status, body: await r.json().catch(() => null) };
        };
        await open();
        const label = "server";
        // Seed a character whose greeting carries the button and whose Lua handles it.
        const ui = (await api("/api/resources/ui/main")).body;
        epoch = ui.epoch ?? epoch;
        const order = (await api("/api/resources/characterOrder/main")).body;
        const presets = (await api("/api/resources/presets/main")).body;
        const modelPresets = (await api("/api/resources/modelPresets/main")).body;
        const personas = (await api("/api/resources/personas/main")).body;
        const chaId = randomUUID();
        const chatId = randomUUID();
        const character = {
            name: `Trigger Char ${label}`,
            firstMessage: `Press <button risu-trigger="go" risu-id="t-77">Run trigger</button> please.`,
            desc: "",
            notes: "",
            chatFolders: [],
            emotionImages: [],
            bias: [],
            viewScreen: "none",
            globalLore: [],
            chaId,
            type: "character",
            utilityBot: false,
            customscript: [],
            exampleMessage: "",
            creatorNotes: "",
            systemPrompt: "",
            postHistoryInstructions: "",
            alternateGreetings: [],
            tags: [],
            creator: "",
            characterVersion: "",
            personality: "",
            scenario: "",
            firstMsgIndex: -1,
            replaceGlobalNote: "",
            triggerscript: TRIGGERS,
        };
        const seeded = await api("/api/resources/batch", {
            method: "POST",
            body: JSON.stringify({
                ops: [
                    { kind: "ui", id: "main", baseRevision: ui.revision, data: { ...ui.data, didFirstSetup: true } },
                    { kind: "characters", id: chaId, baseRevision: null, data: character },
                    {
                        kind: "characterOrder",
                        id: "main",
                        baseRevision: order.revision,
                        data: [...(Array.isArray(order.data) ? order.data : []), chaId],
                    },
                ],
                // A bound chat: a command job runs on its chat's binding or not at all, and a
                // character's first chat starts unbound.
                chats: [
                    {
                        characterId: chaId,
                        chatId,
                        baseRevision: null,
                        ops: [
                            {
                                op: "create",
                                chat: {
                                    id: chatId,
                                    name: "Chat 1",
                                    fmIndex: -1,
                                    message: [],
                                    ...chatBindingFixture(modelPresets, presets, personas),
                                },
                            },
                        ],
                    },
                ],
            }),
        });
        check(`${label}: seeded`, seeded.status === 200, seeded);
        await open();
        requests.length = 0;
        await openCharacterChat(page, chaId);
        const button = page.locator('[risu-trigger="go"]').first();
        await button.waitFor({ timeout: 15000 });
        const clickedAt = consoleLines.length;
        await button.click();
        // The alert, then the question, through the UI.
        // Through the job channel the alert and the question are queued and shown one at a time;
        // in the browser path `alertNormal` does not wait, so the question replaces it at once.
        await page
            .getByText("hello from the trigger")
            .first()
            .waitFor({ timeout: 20000 })
            .catch(async (error) => {
                console.log(
                    "requests:",
                    JSON.stringify(
                        requests
                            .filter((r) => r.url.includes("/api/"))
                            .map((r) => `${r.method} ${new URL(r.url).pathname}`),
                    ),
                );
                console.log("console:", consoleLines.slice(clickedAt).join("\n"));
                console.log("errors:", pageErrors);
                if (process.env.SHOT) {
                    await page.screenshot({ path: process.env.SHOT });
                }
                console.log("frames:", frames.join("\n"));
                throw error;
            });
        await page.getByRole("button", { name: "OK", exact: true }).first().click();
        await page.getByText("Who clicked?").first().waitFor({ timeout: 20000 });
        await page.locator("#alert-input").fill("Ada");
        await page.getByRole("button", { name: "OK", exact: true }).first().click();
        const reply = `trigger says Ada id=t-77`;
        await page
            .getByText(reply)
            .first()
            .waitFor({ timeout: 20000 })
            .catch(() => {});
        check(`${label}: the button's message is shown`, (await page.getByText(reply).count()) > 0, {
            tail: (await page.evaluate(() => document.body.innerText)).slice(-600),
        });
        await page
            .getByText("second edited")
            .first()
            .waitFor({ timeout: 10000 })
            .catch(() => {});
        check(`${label}: the v2ModifyChat edit is shown`, (await page.getByText("second edited").count()) > 0);
        // `/trigger typed` from the chat input.
        await page.waitForTimeout(1000);
        const input = page.locator("textarea.input-text").first();
        await input.fill("/trigger typed");
        await input.press("Enter");
        await page
            .getByText("typed trigger ran")
            .first()
            .waitFor({ timeout: 20000 })
            .catch(() => {});
        check(`${label}: /trigger from the chat input ran`, (await page.getByText("typed trigger ran").count()) > 0);
        const jobPosts = requests.filter((r) => r.method === "POST" && new URL(r.url).pathname === "/api/generations");
        const bodies = jobPosts.map((r) => JSON.parse(r.body));
        check(
            "server: two command jobs, the button's with its risu-id, the typed one by name",
            bodies.length === 2 &&
                bodies[0].kind === "command" &&
                bodies[0].command?.type === "manual" &&
                bodies[0].command?.name === "go" &&
                bodies[0].context?.triggerId === "t-77" &&
                bodies[1].command?.name === "typed" &&
                bodies[1].context?.triggerId === undefined,
            jobPosts.map((r) => r.body.slice(0, 400)),
        );
        await page.waitForTimeout(2500);
        // Stored, and shown after a reload.
        const stored = (
            await api("/api/resources/read", {
                method: "POST",
                body: JSON.stringify({ chatCollections: [chaId] }),
            })
        ).body?.chatCollections?.[0]?.chats?.[0]?.data?.message?.map((m) => m.data);
        check(
            `${label}: stored on the server`,
            JSON.stringify(stored) === JSON.stringify([reply, "second edited", "typed trigger ran"]),
            stored,
        );
        await open();
        await openCharacterChat(page, chaId);
        await page
            .getByText(reply)
            .first()
            .waitFor({ timeout: 15000 })
            .catch(() => {});
        check(`${label}: shown after a reload`, (await page.getByText(reply).count()) > 0);
        check(`${label}: no page errors`, pageErrors.length === 0, pageErrors);
        const egress = unexpectedEgress(blocked, stack ? await stack.deniedEgress() : []);
        check(`${label}: no unexpected intercepted outbound attempt`, egress.length === 0, egress);
        await context.close();
    };
    await run();
} finally {
    await browser.close();
    await stack?.stop();
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
    if (results.some((ok) => !ok)) {
        process.exitCode = 1;
    }
}
