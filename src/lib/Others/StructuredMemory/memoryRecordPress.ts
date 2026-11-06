import { language } from "src/lang";
import { alertConfirm, alertToast } from "src/ts/alert";
import { runServerJob } from "src/ts/process/serverCommands";
import {
    memoryTestResultView,
    type MemoryTestResultView,
    readStructuredMemoryCost,
} from "src/ts/process/structuredMemory.svelte";
import type { AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
import type { ChatRef } from "src/ts/storage/chatStore.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { selectedHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
import type { GenerationCommand } from "../../../../shared/jobs.ts";
import { isPlainObject } from "../../../../shared/valueKinds.ts";
import {
    normalizeStructuredMemorySettings,
    type StructuredMemoryRebuildMode,
} from "../../../../shared/structuredMemory.ts";

/**
 * Shared command presses for the panel, receipt line, and prompt settings. Requests cross
 * src/ts/process/serverCommands.ts's `runServerJob`, which flushes pending settings and owns job
 * errors; following a busy job is not a new recording or test result. Receipts remain server-written
 * copies: no press invents one locally. Rebuild command presses share this transport.
 */

/** The writer's settings of the selected memory preset. */
function writerSettings() {
    const preset = selectedHypaV3Preset({
        hypaV3Presets: settings.hypaV3Presets.items,
        hypaV3PresetId: settings.hypaV3Presets.selectedId,
    });
    return normalizeStructuredMemorySettings(preset?.settings.structured);
}

/** The turns a window of record now holds, which a preview takes for the cadence's: at most two. */
function recordTurns(): 1 | 2 {
    const { cadence, cadenceTurns } = writerSettings();
    return cadence === "tokens" || (cadence === "everyK" && cadenceTurns > 1) ? 2 : 1;
}

/**
 * A press of "record now" or "resume", wherever the button sits: the `memoryRecord` command through
 * `messageId`, or, with none, resuming on everything open, and the toast that says how the press went.
 * More than one window asks first, with what it would cost, and so does a preview that could not be read.
 */
export async function pressMemoryRecord(owner: AnyClientCharacter, chatRef: ChatRef, messageId?: string) {
    const text = language.structuredMemory.receipt;
    const cost = await readStructuredMemoryCost(chatRef, {
        mode: "record",
        turns: recordTurns(),
        ...(messageId === undefined ? {} : { through: messageId }),
    });
    const question =
        cost.outcome !== "ok"
            ? text.recordCostUnknown
            : cost.value.calls >= 2
              ? text.recordCost(cost.value.calls, cost.value.estimatedTokens)
              : null;
    if (question !== null && !(await alertConfirm(question))) {
        return;
    }
    const { outcome, terminal } = await runServerJob(owner, chatRef, {
        kind: "command",
        command: { type: "memoryRecord", ...(messageId === undefined ? {} : { messageId }) },
        label: "memoryRecord",
        context: { mode: "manual" },
    });
    if (outcome === "followed") {
        alertToast(text.busy);
    } else if (terminal !== null && terminal !== "lost" && terminal.type === "done") {
        const result = isPlainObject(terminal.result) ? terminal.result.memoryRecord : undefined;
        alertToast(result === "completed" ? text.finished : result === "queued" ? text.queued : text.requested);
    }
}

/**
 * A press of the prompts' test run: the `memoryTest` command, whose answer is its job's `done.result`,
 * and nothing is saved but the settings the transport flushes first. Answers what the run showed, or
 * null: this tab's busy job was followed instead (the busy toast), the job was refused or ended in an
 * error (the transport's own alerts), or its terminal carried no result of the test's shape, which a
 * retained terminal, stripped of its payload, does (its own toast).
 */
export async function pressMemoryTest(
    owner: AnyClientCharacter,
    chatRef: ChatRef,
): Promise<MemoryTestResultView | null> {
    const { outcome, terminal } = await runServerJob(owner, chatRef, {
        kind: "command",
        command: { type: "memoryTest" },
        label: "memoryTest",
        context: { mode: "manual" },
    });
    if (outcome === "followed") {
        alertToast(language.structuredMemory.receipt.busy);
        return null;
    }
    if (terminal === null || terminal === "lost" || terminal.type !== "done") {
        return null;
    }
    const view = memoryTestResultView(terminal.result);
    if (view === null) {
        alertToast(language.structuredMemory.settings.testLost);
    }
    return view;
}

/** Runs a `memoryRebuild` command and says how it went. The server starts or refuses it: this only asks. */
async function runRebuildCommand(
    owner: AnyClientCharacter,
    chatRef: ChatRef,
    command: Extract<GenerationCommand, { type: "memoryRebuild" }>,
    started: string,
) {
    const { outcome, terminal } = await runServerJob(owner, chatRef, {
        kind: "command",
        command,
        label: "memoryRebuild",
        context: { mode: "manual" },
    });
    if (outcome === "followed") {
        alertToast(language.structuredMemory.receipt.busy);
    } else if (terminal !== null && terminal !== "lost" && terminal.type === "done") {
        alertToast(started);
    }
}

/**
 * A press of Rebuild or Fill gaps: preview through `readStructuredMemoryCost` in
 * `src/ts/process/structuredMemory.svelte.ts`, then confirmation before the command. A zero-window
 * preview only shows the nothing-to-record toast; an unreadable preview asks with an unknown cost.
 * Windows hold one turn under the `everyTurn` cadence and two under any other.
 */
export async function pressMemoryRebuild(
    owner: AnyClientCharacter,
    chatRef: ChatRef,
    mode: StructuredMemoryRebuildMode,
) {
    const text = language.structuredMemory.rebuild;
    const turns = writerSettings().cadence === "everyTurn" ? 1 : 2;
    const cost = await readStructuredMemoryCost(chatRef, { mode, turns });
    if (cost.outcome === "ok" && cost.value.calls === 0) {
        alertToast(text.nothing);
        return;
    }
    const costText = cost.outcome === "ok" ? text.cost(cost.value.calls, cost.value.estimatedTokens) : text.costUnknown;
    const question = mode === "rebuild" ? text.confirmRebuild(costText) : text.confirmBackfill(costText);
    if (await alertConfirm(question)) {
        await runRebuildCommand(owner, chatRef, { type: "memoryRebuild", mode, turns }, text.started);
    }
}

/** A press of Resume on a stopped rebuild, which takes the settings as they stand now. */
export function pressMemoryRebuildResume(owner: AnyClientCharacter, chatRef: ChatRef) {
    const command = { type: "memoryRebuild", resume: true } as const;
    return runRebuildCommand(owner, chatRef, command, language.structuredMemory.rebuild.resumed);
}
