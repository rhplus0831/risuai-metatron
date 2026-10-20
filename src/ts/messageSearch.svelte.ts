import { untrack } from "svelte";
import {
    MESSAGE_SEARCH_PATH,
    type MessageSearchEpochConflict,
    type MessageSearchPage,
    type MessageSearchQuery,
} from "../../shared/messageSearch.ts";
import { authFetch } from "./storage/serverAuth";
import { currentChatRef, type ChatRef } from "./storage/chatStore.svelte";
import { onCharacterSelectionChanged, selection } from "./storage/selection.svelte";

/**
 * Message search across chats (archived `docs/plan/search.md` slice 4b): the request to the server's scan
 * (`POST /api/chats/search`, slice 4a), the panel's open state and scope, and the jump from a hit to
 * its message, which the chat screen claims once the hit's chat is selected and loaded.
 */

/** Which chats a search scans: every character (not trashed, not the playground), one character, one chat. */
export type MessageSearchScope =
    { kind: "all" } | { kind: "character"; chaId: string } | { kind: "chat"; ref: ChatRef };

/** One page, or why there is none: `epoch` (the data was replaced during the scan: search again). */
export type MessageSearchResult =
    | { kind: "page"; page: MessageSearchPage }
    | { kind: "epoch" }
    | { kind: "aborted" }
    | { kind: "error"; message: string };

/** A scope's identity: equal for the same kind and ids. */
export function messageSearchScopeKey(scope: MessageSearchScope): string {
    switch (scope.kind) {
        case "all":
            return "all";
        case "character":
            return `character\u0000${scope.chaId}`;
        case "chat":
            return `chat\u0000${scope.ref.chaId}\u0000${scope.ref.chatId}`;
    }
}

/** The request body for a query in a scope; a later page passes the previous page's `next`. */
export function messageSearchBody(query: string, scope: MessageSearchScope, cursor?: string): MessageSearchQuery {
    const body: MessageSearchQuery = { query };
    if (scope.kind === "character") {
        body.characterId = scope.chaId;
    } else if (scope.kind === "chat") {
        body.characterId = scope.ref.chaId;
        body.chatId = scope.ref.chatId;
    }
    if (cursor !== undefined) {
        body.cursor = cursor;
    }
    return body;
}

async function errorMessage(response: Response): Promise<string> {
    try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body?.error === "string" && body.error !== "") {
            return body.error;
        }
    } catch {}
    return `HTTP ${response.status}`;
}

/** Asks the server for one page. Never throws: a failed request is an `error` (or `aborted` once `signal` fired). */
export async function searchMessages(
    query: string,
    scope: MessageSearchScope,
    cursor?: string,
    signal?: AbortSignal,
): Promise<MessageSearchResult> {
    try {
        const response = await authFetch(MESSAGE_SEARCH_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(messageSearchBody(query, scope, cursor)),
            signal,
        });
        if (response.ok) {
            return { kind: "page", page: (await response.json()) as MessageSearchPage };
        }
        if (response.status === 409) {
            let body: Partial<MessageSearchEpochConflict> | null = null;
            try {
                body = await response.json();
            } catch {}
            if (body?.reason === "epoch") {
                return { kind: "epoch" };
            }
            return { kind: "error", message: body?.error ?? `HTTP ${response.status}` };
        }
        return { kind: "error", message: await errorMessage(response) };
    } catch (error) {
        if (signal?.aborted) {
            return { kind: "aborted" };
        }
        return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
}

// ---------------------------------------------------------------------------------------------
// The panel

/** The panel's open state and the scope it searches (the panel keeps its query and results across a close). */
export const messageSearchPanel: { open: boolean; scope: MessageSearchScope } = $state({
    open: false,
    scope: { kind: "all" },
});

/** Opens the panel on a scope (the sidebar chat list: its character; the catalog: every character). */
export function openMessageSearch(scope: MessageSearchScope) {
    messageSearchPanel.scope = scope;
    messageSearchPanel.open = true;
}

export function closeMessageSearch() {
    messageSearchPanel.open = false;
}

// ---------------------------------------------------------------------------------------------
// The jump to a message

/** A jump the chat screen runs once: `pending` until claimed, then `claimed` until completed or cancelled. */
export type MessageJump = {
    token: number;
    ref: ChatRef;
    messageId: string;
    state: "pending" | "claimed";
};

type HeldJump = MessageJump & {
    stop: () => void;
    stopped: Promise<void>;
};

let lastToken = 0;
let jump: HeldJump | null = $state(null);

function sameRef(a: ChatRef | null, b: ChatRef | null): boolean {
    return a !== null && b !== null && a.chaId === b.chaId && a.chatId === b.chatId;
}

function drop(held: HeldJump) {
    if (jump === held) {
        jump = null;
    }
    held.stop();
}

/**
 * Whether the jump's chat is the selected one. Leaving it drops the jump (the effect below runs on
 * every flush that changes the selection), so coming back never runs it again. A selection of the
 * same chat again keeps it: the router re-applies the chat's URL with `selectChat` when the catalog
 * closes over it, which bumps `chatSelectionVersion` without a move. A move away and back inside one
 * flush is not seen (no user action does that).
 */
function stillSelected(held: HeldJump): boolean {
    return sameRef(
        untrack(() => currentChatRef()),
        held.ref,
    );
}

/**
 * Records a jump to `messageId` in `ref`, replacing any older jump (pending or claimed), and returns
 * its token. Called right after the hit's chat was selected: a later change of the selection cancels it.
 */
export function requestMessageJump(ref: ChatRef, messageId: string): number {
    const previous = untrack(() => jump);
    if (previous) {
        drop(previous);
    }
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
        stop = resolve;
    });
    lastToken += 1;
    jump = {
        token: lastToken,
        ref: { chaId: ref.chaId, chatId: ref.chatId },
        messageId,
        state: "pending",
        stop,
        stopped,
    };
    return lastToken;
}

/** The pending jump (reactive), for the chat screen's claim effect; null when none waits. */
export function pendingMessageJump(): MessageJump | null {
    return jump?.state === "pending" ? jump : null;
}

/**
 * Takes the pending jump for `ref` once and marks it claimed; null when there is none for that ref, it
 * was claimed already, or the selection left its chat since it was requested (then it is dropped).
 */
export function claimMessageJump(ref: ChatRef): MessageJump | null {
    const held = untrack(() => jump);
    if (!held || held.state !== "pending" || !sameRef(held.ref, ref)) {
        return null;
    }
    if (!stillSelected(held)) {
        drop(held);
        return null;
    }
    held.state = "claimed";
    return { token: held.token, ref: { ...held.ref }, messageId: held.messageId, state: "claimed" };
}

/** Whether the jump with `token` is still held and its chat still selected (checked after every await). */
export function isMessageJumpCurrent(token: number): boolean {
    const held = untrack(() => jump);
    return held !== null && held.token === token && stillSelected(held);
}

/** Settles when the jump with `token` ends (completed, cancelled, replaced, or its chat left); at once when it is gone. */
export function messageJumpStopped(token: number): Promise<void> {
    const held = untrack(() => jump);
    return held !== null && held.token === token ? held.stopped : Promise.resolve();
}

function endMessageJump(token: number) {
    const held = untrack(() => jump);
    if (held && held.token === token) {
        drop(held);
    }
}

/** The jump reached its message (or found it gone); a stale token changes nothing. */
export function completeMessageJump(token: number) {
    endMessageJump(token);
}

/** The jump stopped before reaching its message; a stale token changes nothing. */
export function cancelMessageJump(token: number) {
    endMessageJump(token);
}

// Another character selected (or home): every jump ends, so coming back never runs it again.
onCharacterSelectionChanged(() => {
    const held = untrack(() => jump);
    if (held && selection.characterId !== held.ref.chaId) {
        drop(held);
    }
});

// Another chat of the character selected, or the chat closed: the jump ends.
$effect.root(() => {
    $effect(() => {
        const ref = currentChatRef();
        const open = selection.chatOpen;
        untrack(() => {
            const held = jump;
            if (held && (!open || !sameRef(ref, held.ref))) {
                drop(held);
            }
        });
    });
});
