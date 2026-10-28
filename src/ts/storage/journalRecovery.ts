import { changeLanguage } from "src/lang";
import { SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import { COLLECTION_KIND, COLLECTION_SELECTION_FIELDS, SECTION_KIND } from "../../../shared/sections.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { recordClientEvent } from "../diagnostics/collector";
import {
    characterList,
    checkCharacterInput,
    removeCharacters,
    writeCharacterFieldsAt,
    type AnyClientCharacter,
} from "./characterStore.svelte";
import {
    pageDraftJournal,
    type DraftJournal,
    type DraftMove,
    type MutationEntry,
    type RecordLayerValues,
    type StoredLayers,
} from "./draftJournal";
import { isJournalEligible } from "./journalEligibility";
import { replaceRecord, type RecordKind } from "./records.svelte";
import { recoveryDrafts } from "./recoveryDrafts.svelte";
import { getResourceEpoch } from "./resourceClient";
import { adoptRecoveredRecord, heldRecordSnapshot, sameJson } from "./resourceSync.svelte";
import { reconcileSelection, settings } from "./settingsViews.svelte";

type RecordEntry = Extract<MutationEntry, { scope: "record" }>;
type ServerRecord = ReturnType<typeof heldRecordSnapshot>;
type Intent = RecordLayerValues["latest"];
type Decision =
    | { action: "draft" }
    | { action: "satisfied" }
    | { action: "replay"; text: string | null; unresolvedSent?: RecordLayerValues["sent"] };

function validIntent(intent: Intent): boolean {
    return (
        (intent.baseRevision === null || (typeof intent.baseRevision === "string" && intent.baseRevision.length > 0)) &&
        (intent.op === "delete"
            ? intent.text === null
            : typeof intent.text === "string" &&
              (intent.op === "create"
                  ? intent.baseRevision === null
                  : intent.op === "update" && intent.baseRevision !== null))
    );
}

/**
 * Classifies adapter-produced compact JSON against the untouched boot snapshot. Layer roles order
 * intent; versions only fence storage. A sent update can still land after this snapshot was read.
 */
export function decideRecordRecovery(layers: StoredLayers<"record">, server: ServerRecord): Decision {
    const sent = layers.sent?.value;
    const latest = layers.latest?.value;
    const draft: Decision = { action: "draft" };
    const satisfied: Decision = { action: "satisfied" };
    if (sent?.op === "create" && !server) return draft;
    if (layers.refused || (!sent && !latest)) return draft;
    if (
        (sent && (!validIntent(sent) || sent.dispatched !== true || typeof sent.inDoubt !== "boolean")) ||
        (latest && !validIntent(latest))
    )
        return draft;

    const final = latest ?? sent!;
    // An update cannot authorize resurrection, including a re-add behind an unanswered delete.
    if (!server && (sent?.op === "update" || final.op === "update")) return draft;
    if (sent?.op === "delete" && !server) return final.text === null ? satisfied : draft;

    const sentMatches = sent?.text != null && server !== null && sameJson(sent.text, server.text);
    if (sent && latest) {
        // Newer intent is based on the original request, or on its recognized current value.
        if (latest.baseRevision !== sent.baseRevision && !(sentMatches && latest.baseRevision === server!.revision))
            return draft;
        if (latest.op === "create" && sent.op !== "create") return draft;
    }
    const finalMatches = final.text === null ? server === null : server !== null && sameJson(final.text, server.text);
    if (sentMatches) {
        return finalMatches ? satisfied : { action: "replay", text: final.text };
    }
    if (sent?.op === "update" && server?.revision === sent.baseRevision) {
        // Even a final value equal to the snapshot must wait behind the unresolved sent value.
        return { action: "replay", text: final.text, unresolvedSent: sent };
    }
    if (sent?.op === "delete" && server?.revision === sent.baseRevision && finalMatches) {
        // The unanswered delete can still remove this revision. A re-add equal to the snapshot
        // produces no local diff, and the adapter cannot hold a null in-doubt value: preserve it.
        return draft;
    }
    if (finalMatches) return satisfied;
    if (sent && (!server || sent.baseRevision !== server.revision)) return draft;
    if (!server) {
        return final.op === "create" && !sent ? { action: "replay", text: final.text } : draft;
    }
    return final.baseRevision === server.revision ? { action: "replay", text: final.text } : draft;
}

const singletonKinds = new Set<string>([
    ...Object.values(SECTION_KIND),
    ...Object.values(COLLECTION_KIND),
    "presets",
    "modules",
]);
const objectKinds = new Set<string>([...Object.values(SECTION_KIND), "globalChatVariables", "statics"]);

/** Validate without normalizing: the normal save collector owns character canonicalization. */
function checkedValue(kind: string, id: string, text: string): unknown {
    const value: unknown = JSON.parse(text);
    if (kind === "characters") {
        checkCharacterInput(value);
        if (value.chaId !== id || ["chats", "chatPage", "reloadKeys"].some((key) => Object.hasOwn(value, key))) {
            throw new Error("Recovery requires a character's own fields with the exact target id");
        }
    } else if (Object.hasOwn(COLLECTION_SELECTION_FIELDS, kind)) {
        if (!isPlainObject(value) || !Array.isArray(value.items) || typeof value.selectedId !== "string") {
            throw new Error("Recovery requires the whole selectable collection");
        }
    } else if (objectKinds.has(kind) ? !isPlainObject(value) : !Array.isArray(value)) {
        throw new Error("Unsupported recovered record shape");
    }
    return value;
}

type Installation = {
    entry: RecordEntry;
    kind: string;
    id: string;
    server: ServerRecord;
    decision: Exclude<Decision, { action: "draft" }>;
    value?: unknown;
};

function prepare(entry: RecordEntry): Installation | null {
    const [kind, id, extra] = entry.target.split("\u0000");
    if (
        !kind ||
        !id ||
        extra !== undefined ||
        (kind !== "characters" && (!singletonKinds.has(kind) || id !== SINGLETON_RESOURCE_ID))
    ) {
        return null;
    }
    // Use the existing boundary for every layer, including an earlier sent value. Ineligible rows
    // go through moveToDrafts, which removes them without copying their content into a draft.
    for (const layer of Object.values(entry.layers)) {
        if (!isJournalEligible({ scope: "record", kind, text: layer.value.text })) return null;
        if (layer.value.text === null) {
            if (kind !== "characters") return null;
        } else {
            checkedValue(kind, id, layer.value.text);
        }
    }
    const server = heldRecordSnapshot(kind, id);
    const decision = decideRecordRecovery(entry.layers, server);
    if (decision.action === "draft") return null;
    const text = decision.action === "replay" ? decision.text : server?.text;
    return {
        entry,
        kind,
        id,
        server,
        decision,
        value: text != null ? checkedValue(kind, id, text) : undefined,
    };
}

function install(item: Installation) {
    const { entry, kind, id, server, decision, value } = item;
    // A satisfied whole record also wins over any first-boot overlay. It still compares equal to
    // the server baseline, so the initial save pass sends nothing for it.
    if (decision.action === "replay" || server) {
        if (kind === "characters") {
            const characters = characterList();
            const index = characters.findIndex((character) => character.chaId === id);
            if (index >= 0 !== (server !== null)) throw new Error("Recovered character membership changed");
            if (decision.action === "replay" && decision.text === null) {
                if (!removeCharacters([id]).includes(id)) throw new Error("Recovered character could not be removed");
            } else {
                // The index is resolved and used in this task, with no asynchronous gap. Appending
                // fields avoids import transforms and leaves the first chat to initializeChats.
                writeCharacterFieldsAt(index < 0 ? characters.length : index, value as AnyClientCharacter);
            }
        } else {
            replaceRecord(kind as RecordKind, value);
        }
    }
    adoptRecoveredRecord(entry, decision.action === "replay" ? decision.unresolvedSent : undefined);
}

class RecoveryTimeout extends Error {}

/**
 * Claims and classifies durable intent before any recovered local write. The deadline covers all
 * reads and moves; failure closes the journal (its bounded drain adds at most its open timeout).
 */
export async function recoverJournal(
    options: { journal?: DraftJournal; timeoutMs?: number; now?: () => number } = {},
): Promise<void> {
    const journal = options.journal ?? pageDraftJournal();
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? 5000;
    const deadline = now() + timeoutMs;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
        if (!active || now() >= deadline) throw new RecoveryTimeout();
    };
    const recover = async () => {
        const enabled = await journal.start();
        check();
        if (!enabled || !journal.enabled) return;
        await journal.adoptOrphans();
        check();
        const rows = await journal.readOwn();
        check();
        const epoch = getResourceEpoch();
        const moves: DraftMove[] = [];
        const installations: Installation[] = [];
        for (const entry of rows) {
            check();
            if (entry.epoch === epoch && entry.scope !== "record") continue;
            let item: Installation | null = null;
            if (entry.epoch === epoch && entry.scope === "record") {
                try {
                    item = prepare(entry);
                } catch {
                    // One malformed row becomes a draft; it never blocks another target's recovery.
                }
            }
            if (item) installations.push(item);
            else moves.push({ epoch: entry.epoch, scope: entry.scope, target: entry.target, version: entry.version });
        }
        check();
        const moved = moves.length ? await journal.moveToDrafts(moves) : [];
        check();
        // Adoption may itself have drafted a collision, even when this tab has no mutation rows.
        const drafts = await journal.listDrafts();
        check();

        // No more awaits: characters precede their order vector, then selection and locale see the
        // final records. The server baseline and the boot cache's captured snapshot stay untouched.
        installations.sort((a, b) => rank(a.kind) - rank(b.kind));
        let recovered = moved.filter((id) => id !== null).length;
        for (const item of installations) {
            try {
                install(item);
                recovered += 1;
            } catch {
                // A local writer can refuse a malformed row. Keep its durable layers for another
                // boot, continue the other targets, and never claim that this row was recovered.
                recordClientEvent({ kind: "sync", phase: "journalSkipped", reason: "format", entries: 1 });
            }
        }
        reconcileSelection();
        changeLanguage(settings.ui.language);
        recoveryDrafts.replace(drafts, epoch);
        // Adoption has its own reason: orphan. This count describes only this boot's decisions.
        if (recovered > 0) recordClientEvent({ kind: "sync", phase: "journalRecovered", entries: recovered });
    };
    try {
        await Promise.race([
            recover(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    active = false;
                    reject(new RecoveryTimeout());
                }, timeoutMs);
            }),
        ]);
    } catch (error) {
        active = false;
        recordClientEvent({
            kind: "sync",
            phase: "journalFailed",
            reason: error instanceof RecoveryTimeout ? "timeout" : "readFailed",
        });
        // close() disables calls synchronously before waiting for its bounded drain. A late read
        // cannot pass check(), and the save adapter checks enabled beside start()'s cached answer.
        await journal.close();
    } finally {
        active = false;
        clearTimeout(timer);
    }
}

function rank(kind: string) {
    return kind === "characters" ? 0 : kind === "characterOrder" ? 2 : 1;
}
