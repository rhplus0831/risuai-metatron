// Captures the fixtures of the app from before the settings were split into section records into
// src/ts/storage/tests/fixtures/boot/:
//
// - boot-snapshot.json: `getDatabase({ snapshot: true })` right after the first boot on an empty
//   server, before anything else runs.
// - default.risup: `downloadPreset(0, "return")` of the default preset.
// - custom.risup: a copy of the default preset with non-default preset-owned fields.
//
// Usage: node util/playwright/captureBootFixtures.mjs [outDir]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import * as prettier from "prettier";
import { chromePath, openApp, repoRoot, startStack } from "./stack.mjs";

const outDir = path.resolve(process.argv[2] ?? path.join(repoRoot, "src/ts/storage/tests/fixtures/boot"));

const stack = await startStack({ serverPort: 6111, vitePort: 5211 });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await openApp(page, stack.baseURL);

    const snapshot = await page.evaluate(async () => {
        const { getDatabase } = await import("/src/ts/storage/database.svelte.ts");
        return getDatabase({ snapshot: true });
    });

    const exportPreset = (id) =>
        page.evaluate(async (presetId) => {
            const { downloadPreset } = await import("/src/ts/storage/database.svelte.ts");
            const result = await downloadPreset(presetId, "return");
            return Array.from(result.buf);
        }, id);

    const defaultRisup = await exportPreset(0);

    const customId = await page.evaluate(async () => {
        const { DBState } = await import("/src/ts/stores.svelte.ts");
        const { changeToPreset, copyPreset } = await import("/src/ts/storage/database.svelte.ts");
        copyPreset(0);
        const id = DBState.db.botPresets.length - 1;
        changeToPreset(id);
        const db = DBState.db;
        db.botPresets[id].name = "커스텀 プリセット ✓";
        db.temperature = 123;
        db.maxResponse = 777;
        db.mainPrompt = "Main prompt ✓ {{char}}";
        db.NAIsettings = { ...db.NAIsettings, cfg_scale: 2.5, starter: "⁂", topK: 11 };
        db.reasoningEffort = 2;
        db.presetRegex = [{ comment: "phase3", in: "foo", out: "bar", type: "editoutput", ableFlag: false }];
        db.ooba = { ...db.ooba, top_p: 0.77, max_new_tokens: 321 };
        db.reverseProxyOobaArgs = { ...db.reverseProxyOobaArgs, mode: "instruct", top_k: 7 };
        db.promptTemplate = [
            { type: "plain", type2: "main", text: "System ✓", role: "system" },
            { type: "chat", rangeStart: 0, rangeEnd: "end" },
        ];
        db.seperateParameters = {
            ...db.seperateParameters,
            memory: { temperature: 50, top_p: 0.5 },
            overrides: { "gpt-4o": { temperature: 42 } },
        };
        return id;
    });
    const customRisup = await exportPreset(customId);

    if (pageErrors.length > 0) {
        console.warn("Page errors during capture:\n" + pageErrors.join("\n"));
    }

    await mkdir(outDir, { recursive: true });
    const snapshotFile = path.join(outDir, "boot-snapshot.json");
    const prettierOptions = (await prettier.resolveConfig(snapshotFile)) ?? {};
    await writeFile(
        snapshotFile,
        await prettier.format(JSON.stringify(snapshot), { ...prettierOptions, filepath: snapshotFile }),
    );
    await writeFile(path.join(outDir, "default.risup"), Buffer.from(defaultRisup));
    await writeFile(path.join(outDir, "custom.risup"), Buffer.from(customRisup));
    console.log(`Wrote boot-snapshot.json, default.risup, custom.risup to ${outDir}`);
} finally {
    await browser.close();
    await stack.stop();
}
