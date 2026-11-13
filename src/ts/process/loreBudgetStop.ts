import { get } from "svelte/store";
import type { LoreBudgetStop } from "../../../shared/contextReport.ts";
import { findChat, type ChatRef } from "../storage/chatStore.svelte";
import { settings } from "../storage/settingsViews.svelte";
import { loreBudgetStopDialog, type LoreBudgetStopChoice, type LoreBudgetStopRequest } from "../stores.svelte";

/**
 * The tab's side of a send that stops over the lore budget: whether a send asks its job for the stop
 * (`wantsLoreBudgetStop`), and the dialog that asks the user what to do about one
 * (`askLoreBudgetStop`). The job decides the stop itself (`context.stopOverLoreBudget`); the server
 * reads neither the setting nor the chat's flag.
 */

/**
 * Whether a send from the chat screen in `ref` asks its job to stop when the lore budget leaves an
 * activated entry out: the Interaction setting is on and the chat has not turned the warning off
 * (`loreBudgetWarnOff`). The only reader of the two for the stop; a chat that is not loaded counts
 * as not having turned it off.
 */
export function wantsLoreBudgetStop(ref: ChatRef): boolean {
    return settings.ui.loreBudgetStop === true && findChat(ref)?.loreBudgetWarnOff !== true;
}

/** The stops that arrived while a dialog was open, oldest first. */
const waiting: LoreBudgetStopRequest[] = [];

/**
 * Opens the lore budget stop dialog for a stopped send of `ref` and resolves with the user's choice.
 * One dialog shows at a time: a stop that arrives while one is open waits, and they open in the
 * order they were asked. Each request is answered once, through its own `resolve`: Escape, the
 * dialog's teardown, and its chat leaving the list answer `close`, and answering the shown request
 * shows the next one without answering it. `messageKept`: the send appended a user message.
 */
export function askLoreBudgetStop(
    ref: ChatRef,
    stop: LoreBudgetStop,
    options: { messageKept?: boolean } = {},
): Promise<LoreBudgetStopChoice> {
    return new Promise((resolve) => {
        let answered = false;
        const request: LoreBudgetStopRequest = {
            ref,
            stop,
            messageKept: options.messageKept === true,
            resolve: (choice) => {
                if (answered) {
                    return;
                }
                answered = true;
                const index = waiting.indexOf(request);
                if (index !== -1) {
                    waiting.splice(index, 1);
                }
                if (get(loreBudgetStopDialog) === request) {
                    loreBudgetStopDialog.set(waiting.shift() ?? null);
                }
                resolve(choice);
            },
        };
        if (get(loreBudgetStopDialog) === null && waiting.length === 0) {
            loreBudgetStopDialog.set(request);
        } else {
            waiting.push(request);
        }
    });
}
