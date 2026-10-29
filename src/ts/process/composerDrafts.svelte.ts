import { onChatRemoved, type ChatRemoval } from "../storage/chatStore.svelte";
import { pageDraftJournal, type ComposerValue, type DraftJournal } from "../storage/draftJournal";
import { composerSendText, type SendDraft } from "./sendDraft";

export type ComposerDraft = { input: string; translate: string; files: string[] };
/** A chat's live composer while shown, or its stashed draft otherwise. */
export type ComposerView = ComposerDraft & { addFile(id: string): void; removeFileAt(index: number): void };

type ComposerOptions = {
    journal?: DraftJournal;
    debounceMs?: number;
    epoch?: () => string;
    retryIdFor?: (key: string, text: string) => Pick<SendDraft, "userMessageId" | "requestId"> | undefined;
};
type RestoreChecks = {
    landed(userMessageId: string): Promise<boolean | undefined>;
    inlayExists(id: string): Promise<boolean | undefined>;
};

class ComposerState implements ComposerDraft {
    input = $state("");
    translate = $state("");
    files: string[] = $state([]);
}

const empty = (draft: ComposerDraft) => draft.input === "" && draft.translate === "" && draft.files.length === 0;
const snapshot = (draft?: ComposerDraft): ComposerDraft => ({
    input: draft?.input ?? "",
    translate: draft?.translate ?? "",
    files: [...(draft?.files ?? [])],
});
const composers = new Set<{
    journal?: DraftJournal;
    flush(): Promise<void>;
    forget(removal: ChatRemoval): void;
}>();
// A send can outlive its screen; a remount must still leave its hand-off alone.
const sending = new Map<string, Set<string>>();
let watchingVisibility = false;

function watchVisibility() {
    if (watchingVisibility || typeof document === "undefined") return;
    watchingVisibility = true;
    const flush = () => {
        for (const composer of composers) void composer.flush();
    };
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", flush);
}

onChatRemoved((removal) => {
    for (const key of sending.keys()) {
        if (
            removal.chatId === null
                ? key.startsWith(`${removal.chaId}\u0000`)
                : key === `${removal.chaId}\u0000${removal.chatId}`
        ) {
            sending.delete(key);
        }
    }
    const journals = new Set([pageDraftJournal()]);
    for (const composer of composers) {
        composer.forget(removal);
        if (composer.journal) journals.add(composer.journal);
    }
    for (const journal of journals) void journal.removeComposersOf(removal.chaId, removal.chatId ?? undefined);
});

/** Keeps per-chat composers, optionally journaling their edits and send hand-offs in this browser. */
export function createComposer({ journal, debounceMs = 500, epoch, retryIdFor }: ComposerOptions = {}) {
    const live = new ComposerState();
    const drafts = new Map<string, ComposerDraft>();
    const dirty = new Set<string>();
    const edits = new Map<string, number>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const lastWritten = new Map<string, string>();
    const removedKeys = new Set<string>();
    const removedCharacters = new Set<string>();
    const reopened = new Set<string>();
    let shown: string | null = null;
    let generation = 0;
    let destroyed = false;

    const read = (key: string) => (key === shown ? live : drafts.get(key));
    const version = (key: string) => edits.get(key) ?? 0;
    const removed = (key: string) =>
        removedKeys.has(key) || (removedCharacters.has(key.split("\u0000")[0]) && !reopened.has(key));
    const requestIdentity = (requestId?: string) => {
        const requestEpoch = epoch?.();
        return requestId === undefined || requestEpoch === undefined ? undefined : { requestId, requestEpoch };
    };
    function cancelTimer(key: string) {
        clearTimeout(timers.get(key));
        timers.delete(key);
    }
    function changed(key: string | null) {
        if (key === null) return;
        edits.set(key, version(key) + 1);
        schedule(key);
    }
    function schedule(key: string) {
        if (!journal || destroyed || removed(key)) return;
        dirty.add(key);
        cancelTimer(key);
        timers.set(
            key,
            setTimeout(() => void write(key), debounceMs),
        );
    }

    /**
     * With `takeOver`, the written draft replaces that send's hand-off, whose text the composer now
     * holds; it keeps the send's ids only while its text still equals the sent text.
     */
    async function write(key: string, takeOver?: string): Promise<void> {
        cancelTimer(key);
        if (!journal || !dirty.has(key) || removed(key)) return;
        const edit = version(key);
        const draft = snapshot(read(key));
        if (empty(draft)) {
            lastWritten.delete(key);
            dirty.delete(key);
            await journal.removeComposer(key);
            return;
        }
        const retry = retryIdFor?.(key, composerSendText(draft));
        const value: ComposerValue = {
            ...draft,
            ...(retry === undefined ? {} : { userMessageId: retry.userMessageId, ...requestIdentity(retry.requestId) }),
        };
        const text = JSON.stringify(value);
        if (takeOver === undefined && lastWritten.get(key) === text) {
            dirty.delete(key);
            return;
        }
        lastWritten.delete(key);
        const outcome = await journal.putComposer(key, value, takeOver);
        if (outcome === "written" && version(key) === edit && !removed(key)) {
            lastWritten.set(key, text);
            dirty.delete(key);
        }
    }

    async function flush(): Promise<void> {
        await Promise.all([...dirty].map((key) => write(key)));
    }

    /** Stashes the previous chat's nonempty draft and loads the next chat's composer. */
    function switchTo(key: string | null): void {
        if (destroyed) return;
        if (key !== null) {
            removedKeys.delete(key);
            reopened.add(key);
        }
        if (key === shown) return;
        generation++;
        if (shown !== null) {
            if (empty(live) || removed(shown)) drafts.delete(shown);
            else drafts.set(shown, snapshot(live));
        }
        const draft = key === null ? undefined : drafts.get(key);
        shown = key;
        if (key !== null) drafts.delete(key);
        Object.assign(live, snapshot(draft));
    }

    function view(keyOf: () => string | null): ComposerView {
        const current = () => {
            const key = keyOf();
            return key === null ? live : read(key);
        };
        function set<K extends keyof ComposerDraft>(field: K, value: ComposerDraft[K]) {
            const key = keyOf();
            if (destroyed || (key !== null && removed(key))) return;
            let draft = current();
            const previous = draft?.[field] ?? (field === "files" ? [] : "");
            if (
                Array.isArray(value) && Array.isArray(previous)
                    ? value.length === previous.length && value.every((id, i) => id === previous[i])
                    : value === previous
            )
                return;
            if (!draft) {
                draft = snapshot();
                drafts.set(key!, draft);
            }
            draft[field] = value;
            changed(key);
        }
        return {
            get input() {
                return current()?.input ?? "";
            },
            set input(value: string) {
                set("input", value);
            },
            get translate() {
                return current()?.translate ?? "";
            },
            set translate(value: string) {
                set("translate", value);
            },
            get files() {
                return current()?.files ?? [];
            },
            set files(value: string[]) {
                set("files", [...value]);
            },
            addFile(id) {
                set("files", [...(current()?.files ?? []), id]);
            },
            removeFileAt(index) {
                set(
                    "files",
                    (current()?.files ?? []).filter((_, i) => i !== index),
                );
            },
        };
    }

    /** Routes reads and writes to this chat even after the shown chat changes. */
    function at(key: string): ComposerView {
        return view(() => key);
    }

    function beginSend(
        key: string,
        send: { snapshot: ComposerDraft; userMessageId: string; requestId?: string },
    ): void {
        if (destroyed || removed(key)) return;
        cancelTimer(key);
        dirty.delete(key);
        edits.set(key, version(key) + 1);
        lastWritten.delete(key);
        const ids = sending.get(key) ?? new Set<string>();
        ids.add(send.userMessageId);
        sending.set(key, ids);
        void journal?.putComposerSend(key, {
            ...snapshot(send.snapshot),
            state: "sending",
            userMessageId: send.userMessageId,
            ...requestIdentity(send.requestId),
        });
    }

    function settleSend(
        key: string,
        userMessageId: string,
        landed: boolean,
        request: { requestId?: string; retainedRequestId?: string } = {},
    ): void {
        sending.get(key)?.delete(userMessageId);
        if (sending.get(key)?.size === 0) sending.delete(key);
        if (!removed(key)) {
            lastWritten.delete(key);
            // A failed send's hand-off stays until its text is placed back in the composer.
            if (landed) void journal?.settleComposerSend(key, userMessageId);
            else
                void journal?.updateComposerRequest(
                    key,
                    { userMessageId, requestId: request.requestId },
                    requestIdentity(request.retainedRequestId),
                );
        }
    }

    /**
     * Puts a failed send's text back in the chat's composer and writes the draft at once, replacing the
     * hand-off; a file queued meanwhile stays and makes the draft a new input without the send's ids.
     */
    function placeSend(key: string, text: string, userMessageId: string): void {
        at(key).input = text;
        if (!journal || destroyed || removed(key)) return;
        dirty.add(key);
        void write(key, userMessageId);
    }

    async function restore(
        key: string,
        checks: RestoreChecks,
    ): Promise<{ userMessageId: string; text: string; requestId?: string } | undefined> {
        const edit = version(key);
        const switched = generation;
        const current = () =>
            !destroyed &&
            !removed(key) &&
            shown === key &&
            generation === switched &&
            version(key) === edit &&
            empty(live);
        if (!journal || !current()) return;
        const draft = await journal.readComposer(key);
        if (!current()) return;
        // A draft typed during a send comes first; the send's hand-off waits for an empty composer.
        const handoff = draft ? null : await journal.readComposerSend(key);
        const value = draft ?? handoff;
        if (!current() || !value) return;
        if (value.state === "sending" && sending.get(key)?.has(value.userMessageId!)) return;
        if (value.userMessageId !== undefined) {
            const landed = await checks.landed(value.userMessageId);
            if (!current()) return;
            if (landed) {
                if (handoff) await journal.settleComposerSend(key, handoff.userMessageId);
                else await journal.removeComposer(key, { userMessageId: value.userMessageId });
                return;
            }
        }
        const exists = await Promise.all(value.files.map((id) => checks.inlayExists(id)));
        if (!current()) return;
        const files = value.files.filter((_, i) => exists[i] !== false);
        Object.assign(live, snapshot({ ...value, files }));
        if (handoff) {
            // The restored draft replaces the hand-off at once, so neither an edit nor clearing the
            // composer can bring the send's text back later. A dropped attachment drops both ids.
            const { state, ...sent } = handoff;
            const restored: ComposerValue = files.length === value.files.length ? sent : snapshot(live);
            const text = JSON.stringify(restored);
            void journal.putComposer(key, restored, handoff.userMessageId).then((outcome) => {
                if (outcome === "written" && version(key) === edit && !removed(key)) lastWritten.set(key, text);
            });
        }
        if (files.length === value.files.length) {
            if (!handoff) lastWritten.set(key, JSON.stringify(value));
            if (value.userMessageId !== undefined)
                return {
                    userMessageId: value.userMessageId,
                    text: composerSendText(live),
                    ...(value.requestId !== undefined && value.requestEpoch === epoch?.()
                        ? { requestId: value.requestId }
                        : {}),
                };
        } else if (!handoff) {
            lastWritten.delete(key);
            schedule(key);
        }
    }

    function forget({ chaId, chatId }: ChatRemoval): void {
        const key = chatId === null ? null : `${chaId}\u0000${chatId}`;
        const matches = (candidate: string) =>
            key === null ? candidate.startsWith(`${chaId}\u0000`) : candidate === key;
        if (key === null) removedCharacters.add(chaId);
        else removedKeys.add(key);
        for (const candidate of new Set([
            ...drafts.keys(),
            ...edits.keys(),
            ...reopened,
            ...(shown === null ? [] : [shown]),
        ])) {
            if (!matches(candidate)) continue;
            cancelTimer(candidate);
            edits.set(candidate, version(candidate) + 1);
            dirty.delete(candidate);
            drafts.delete(candidate);
            lastWritten.delete(candidate);
            reopened.delete(candidate);
        }
    }

    const registration = { journal, flush, forget };
    composers.add(registration);
    if (journal) watchVisibility();
    function destroy(): void {
        if (destroyed) return;
        void flush();
        destroyed = true;
        generation++;
        for (const key of timers.keys()) cancelTimer(key);
        composers.delete(registration);
    }

    return Object.assign(
        view(() => shown),
        { switchTo, at, flush, beginSend, settleSend, placeSend, restore, destroy },
    );
}
