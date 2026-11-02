import { language } from "src/lang";
import { alertConfirm, alertToast } from "src/ts/alert";
import { runServerJob } from "src/ts/process/serverCommands";
import { readStructuredMemoryCost } from "src/ts/process/structuredMemory.svelte";
import type { AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
import type { ChatRef } from "src/ts/storage/chatStore.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { selectedHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
import type { GenerationCommand } from "../../../../shared/jobs.ts";
import {
    normalizeStructuredMemorySettings,
    type StructuredMemoryRebuildMode,
} from "../../../../shared/structuredMemory.ts";

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
        alertToast(text.requested);
    }
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
 * A press of Rebuild or Fill gaps: what it would cost, the question, which always comes, and then the
 * command, in windows of one turn under the `everyTurn` cadence and of two under any other.
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
