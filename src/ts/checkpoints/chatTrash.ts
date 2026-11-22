import { language } from "src/lang";
import { compareRevision, parseRevisionToken } from "../../../shared/resources.ts";
import type { ChatTrashAction, ChatTrashAnswer } from "../../../shared/chats.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { alertConfirm, alertError } from "../alert";
import {
    activeChatCount,
    chatTrashRevision,
    isChatGenerating,
    noteRemoteChat,
    refreshChatEntry,
    settleDeletedChat,
    type ChatRef,
} from "../storage/chatStore.svelte";
import { prepare, request } from "./chatRequest";

/** The delete endpoint echoes the exact state before the cascade. Trash and restore may advance it. */
function validAnswer(body: unknown, ref: ChatRef, revision: string, action: ChatTrashAction): body is ChatTrashAnswer {
    if (!isPlainObject(body) || !isPlainObject(body.summary)) return false;
    const { summary, trashedAt } = body;
    const cmp = compareRevision(body.revision, revision);
    return (
        cmp !== null &&
        cmp >= 0 &&
        (action !== "delete" || cmp === 0) &&
        parseRevisionToken(body.revision)?.seq === parseRevisionToken(revision)?.seq &&
        body.characterId === ref.chaId &&
        body.id === ref.chatId &&
        (action === "restore"
            ? trashedAt === null
            : typeof trashedAt === "number" && Number.isSafeInteger(trashedAt) && trashedAt >= 0) &&
        summary.characterId === ref.chaId &&
        summary.id === ref.chatId &&
        summary.revision === body.revision &&
        summary.trashedAt === (trashedAt ?? undefined) &&
        typeof summary.name === "string" &&
        typeof summary.fmIndex === "number" &&
        Number.isFinite(summary.fmIndex)
    );
}

async function changeTrash(action: ChatTrashAction, ref: ChatRef, revision: string | null): Promise<boolean> {
    if (revision === null) {
        alertError(language.chatTrash.saving);
        return false;
    }
    const refused = await prepare(ref);
    if (refused) {
        if (!refused.noticeShown)
            alertError(refused.reason === "generating" ? language.chatGenerating : language.chatTrash.notSent);
        return false;
    }
    const answer = await request(`/api/chat-trash/${action}`, { characterId: ref.chaId, chatId: ref.chatId, revision });
    if (answer.kind === "failed" && !answer.dispatched) {
        alertError(language.chatTrash.notSent);
        return false;
    }
    if (answer.kind === "response" && answer.status === 200 && validAnswer(answer.body, ref, revision, action)) {
        if (action === "delete") settleDeletedChat(ref, answer.body.revision);
        else noteRemoteChat(ref, answer.body.revision, undefined, answer.body);
        return true;
    }
    const error = answer.kind === "response" && answer.status === 409 ? answer.body?.error : undefined;
    try {
        await refreshChatEntry(ref);
    } catch {
        // A failed readback cannot establish a different outcome.
    }
    alertError(
        error === "lastActiveChat"
            ? language.errors.onlyOneChat
            : error === "generating"
              ? language.chatGenerating
              : error === "stale" || error === "notTrashed"
                ? language.chatTrash.changed
                : language.chatTrash.unknown,
    );
    return false;
}

export const trashChat = (ref: ChatRef, revision: string | null) => changeTrash("trash", ref, revision);
export const restoreChat = (ref: ChatRef, revision: string | null) => changeTrash("restore", ref, revision);
export const deleteChatForever = (ref: ChatRef, revision: string | null) => changeTrash("delete", ref, revision);

export async function confirmTrashChat(ref: ChatRef, name: string) {
    const revision = chatTrashRevision(ref);
    if (revision === null) return trashChat(ref, null);
    if (activeChatCount(ref.chaId) === 1) {
        alertError(language.errors.onlyOneChat);
        return false;
    }
    if (isChatGenerating(ref)) {
        alertError(language.chatGenerating);
        return false;
    }
    return (await alertConfirm(language.chatTrash.confirm(name))) && trashChat(ref, revision);
}
