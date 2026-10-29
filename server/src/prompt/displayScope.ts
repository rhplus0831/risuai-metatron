import { createHash } from "node:crypto";
import type {
    Chat,
    Database,
    ModelPreset,
    ModelProfile,
    RisuPersona,
    botPreset,
    character,
    groupChat,
} from "../../../shared/database.ts";
import type { GenerationContext } from "../../../shared/jobs.ts";
import { RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import {
    characterShell,
    forwardPersonaRoots,
    forwardSelectedPreset,
    projectCollections,
    projectSections,
} from "../data/databaseProjection.ts";
import type { ResourceKind, ResourceKindRegistry } from "../data/kinds.ts";
import { isValidResourceId, type ResourceStore } from "../data/resourceStore.ts";
import { bindingLookup, checkChatBinding } from "../jobs/chatBinding.ts";
import { GenerationRunnerError } from "../jobs/generationJobs.ts";
import { ChatBindingError, jobScopeKinds, readCharacters, type CharacterRead, type JobScope } from "../jobs/jobScope.ts";
import { buildRequestDb } from "../llm/settings.ts";

/** Shared entries and request-owned data pinned by pending renders, including running continuations. */
export const MAX_RETAINED_BYTES = 64 * 1024 * 1024;
const MAX_CONFIGURATION_ENTRIES = 2;
const MAX_CONFIGURATION_BYTES = 32 * 1024 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 8;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
/** Digests of stored characters, by id and revision, shared by loads and result-cache probes. */
const MAX_CHARACTER_IDENTITIES = 1_024;
/** Object headers and storage slots include slack for V8's record and collection storage. */
const SNAPSHOT_OBJECT_BYTES = 64;
const SNAPSHOT_SLOT_BYTES = 32;
const SNAPSHOT_SCALAR_BYTES = 16;

/** An immutable raw entry's charge and the objects already covered by it. Pins outlive cache eviction. */
export type DisplayScopeEntry = {
    readonly bytes: number;
    readonly objects: WeakSet<object>;
};
type Entry<T> = DisplayScopeEntry & { readonly value: T };
type CacheBounds = { maxEntries: number; maxBytes: number };

/** Conservative retained data estimate, stopping above `cap`; shared objects are skipped by identity. */
export function retainedBytes(
    value: unknown,
    cap: number,
    options: { objects?: WeakSet<object>; exclude?: readonly DisplayScopeEntry[] } = {},
): number {
    let bytes = 0;
    const seen = options.objects ?? new WeakSet<object>();
    const stack: unknown[] = [value];
    // UTF-16 length is a lower bound on UTF-8 bytes: reject huge strings without scanning them.
    const stringBytes = (text: string) => (text.length > cap - bytes ? cap + 1 : Buffer.byteLength(text));
    while (stack.length > 0 && bytes <= cap) {
        const value = stack.pop();
        if (typeof value === "string") {
            bytes += stringBytes(value);
        } else if (typeof value !== "object" || value === null) {
            if (typeof value === "number" || typeof value === "boolean") {
                bytes += SNAPSHOT_SCALAR_BYTES;
            }
        } else if (!seen.has(value) && !options.exclude?.some((entry) => entry.objects.has(value))) {
            seen.add(value);
            bytes += SNAPSHOT_OBJECT_BYTES;
            if (bytes > cap) {
                break;
            }
            if (value instanceof Map) {
                for (const [key, entry] of value) {
                    bytes += SNAPSHOT_SLOT_BYTES;
                    if (bytes > cap) {
                        return bytes;
                    }
                    stack.push(key, entry);
                }
            } else if (value instanceof Set) {
                for (const entry of value) {
                    bytes += SNAPSHOT_SLOT_BYTES;
                    if (bytes > cap) {
                        return bytes;
                    }
                    stack.push(entry);
                }
            } else {
                const record = value as Record<string, unknown>;
                for (const key in record) {
                    if (Object.hasOwn(record, key)) {
                        bytes += SNAPSHOT_SLOT_BYTES;
                        bytes += stringBytes(key);
                        if (bytes > cap) {
                            return bytes;
                        }
                        stack.push(record[key]);
                    }
                }
            }
        }
    }
    return bytes;
}

/** An LRU of raw reads; an oversized value still gets a handle but is never cached. */
function createEntryCache<T>(bounds: CacheBounds) {
    const entries = new Map<string, Entry<T>>();
    let bytes = 0;
    return {
        get(key: string): Entry<T> | undefined {
            const entry = entries.get(key);
            if (entry) {
                entries.delete(key);
                entries.set(key, entry);
            }
            return entry;
        },
        insert(key: string, value: T): Entry<T> {
            const objects = new WeakSet<object>();
            const entry = {
                value,
                objects,
                bytes: retainedBytes(value, Math.max(MAX_RETAINED_BYTES, bounds.maxBytes), { objects }),
            };
            if (bounds.maxEntries > 0 && entry.bytes <= bounds.maxBytes) {
                while (entries.size >= bounds.maxEntries || bytes + entry.bytes > bounds.maxBytes) {
                    const oldest = entries.keys().next().value!;
                    bytes -= entries.get(oldest)!.bytes;
                    entries.delete(oldest);
                }
                entries.set(key, entry);
                bytes += entry.bytes;
            }
            return entry;
        },
        clear() {
            entries.clear();
            bytes = 0;
        },
        stats: () => ({ entries: entries.size, bytes }),
    };
}

/**
 * Captures a display projection in synchronous reads: raw settings and transcripts are reused by
 * revision, while characters and every context-dependent wrapper belong to this request. Display
 * callers must only mutate their target overlays, never these raw entries or their containers.
 */
export function createDisplayScopeLoader(
    store: ResourceStore,
    kinds: ResourceKindRegistry,
    options: { configuration?: Partial<CacheBounds>; transcripts?: Partial<CacheBounds> } = {},
) {
    const configurationCache = createEntryCache<ReturnType<ResourceStore["readKinds"]>["kinds"]>({
        maxEntries: MAX_CONFIGURATION_ENTRIES,
        maxBytes: MAX_CONFIGURATION_BYTES,
        ...options.configuration,
    });
    const transcriptCache = createEntryCache<ReturnType<ResourceStore["readChatSource"]>>({
        maxEntries: MAX_TRANSCRIPT_ENTRIES,
        maxBytes: MAX_TRANSCRIPT_BYTES,
        ...options.transcripts,
    });
    const characterIdentities = new Map<string, string>();
    const identityKey = (id: string, revision: string) => JSON.stringify([id, revision]);
    const memoizedIdentity = (key: string): string | undefined => {
        const identity = characterIdentities.get(key);
        if (identity !== undefined) {
            characterIdentities.delete(key);
            characterIdentities.set(key, identity);
        }
        return identity;
    };

    /**
     * Keep the frozen legacy `lastInteraction` excluded so existing display identities stay stable.
     * Preserve JSON property order: CBS
     * `lorebook` serializes entries with JSON.stringify. Memoize under the revision returned with
     * these data, never a token looked up before the read. Absence has the fixed identity `missing`.
     */
    const identityOf = (record: CharacterRead): string => {
        if (record.data === null || record.revision === null) {
            return "missing";
        }
        const key = identityKey(record.id, record.revision);
        const memo = memoizedIdentity(key);
        if (memo !== undefined) {
            return memo;
        }
        const { lastInteraction, ...rest } = record.data as Record<string, unknown>;
        const identity = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
        characterIdentities.set(key, identity);
        if (characterIdentities.size > MAX_CHARACTER_IDENTITIES) {
            characterIdentities.delete(characterIdentities.keys().next().value!);
        }
        return identity;
    };

    /**
     * Current identities for a result-cache probe. An absent revision means `missing`; an evicted
     * digest means unknown and must read the record. A stamp costs one read and digest, then hits
     * the memo even when the display identity is unchanged.
     */
    const resolveIdentities = (
        ids: Iterable<string>,
        revisions: ReadonlyMap<string, string>,
    ): ReadonlyMap<string, string> => {
        const charactersKind = kinds.get(RESOURCE_KIND.characters);
        if (!charactersKind) {
            throw new Error(`Unknown resource kind ${RESOURCE_KIND.characters}`);
        }
        const identities = new Map<string, string>();
        const unread: { kind: ResourceKind; id: string }[] = [];
        for (const id of new Set(ids)) {
            const revision = revisions.get(`${RESOURCE_KIND.characters}/${id}`);
            if (revision === undefined || !isValidResourceId(id)) {
                identities.set(id, "missing");
                continue;
            }
            const memo = memoizedIdentity(identityKey(id, revision));
            if (memo === undefined) {
                unread.push({ kind: charactersKind, id });
            } else {
                identities.set(id, memo);
            }
        }
        if (unread.length > 0) {
            for (const record of store.readRefs(unread).items) {
                identities.set(record.id, identityOf(record));
            }
        }
        return identities;
    };

    const load = (
        context: GenerationContext,
        options: { characters?: (chat: Chat, owner: character | groupChat) => Iterable<string> } = {},
    ): { scope: JobScope; entries: readonly DisplayScopeEntry[]; identities: ReadonlyMap<string, string> } => {
        const charactersKind = kinds.get(RESOURCE_KIND.characters);
        if (!charactersKind) {
            throw new Error(`Unknown resource kind ${RESOURCE_KIND.characters}`);
        }
        const configurationKinds = jobScopeKinds(kinds).filter((kind) => kind !== charactersKind);
        const read = store.readKindRevisions(configurationKinds);
        // Every id and revision, in creation order: additions and deletions change the key too.
        const configurationKey = JSON.stringify([read.epoch, read.kinds]);
        const configuration =
            configurationCache.get(configurationKey) ??
            configurationCache.insert(configurationKey, store.readKinds(configurationKinds).kinds);
        const transcriptKey = JSON.stringify([
            read.epoch,
            context.characterId,
            context.chatId,
            store.chatRevision(context.characterId, context.chatId),
            store.chatSourceGeneration(context.characterId, context.chatId),
        ]);
        const transcript =
            transcriptCache.get(transcriptKey) ??
            transcriptCache.insert(transcriptKey, store.readChatSource(context.characterId, context.chatId));
        const chatRecord = transcript.value;
        const characterRevisions = new Map<string, string | null>();
        const identities = new Map<string, string>();
        const characterRecords = readCharacters(
            store,
            charactersKind,
            context,
            chatRecord.data,
            options.characters,
            (record) => {
                characterRevisions.set(record.id, record.revision);
                identities.set(record.id, identityOf(record));
            },
        );
        const single = (name: string): any =>
            configuration.value[name]?.find((record) => record.id === SINGLETON_RESOURCE_ID)?.data;

        const db: Record<string, unknown> = {};
        projectSections(db, single);
        projectCollections(db, single);
        const presets = (single(RESOURCE_KIND.presets) ?? []) as botPreset[];
        db.botPresets = presets;
        db.modules = single(RESOURCE_KIND.modules) ?? [];

        // Check the chat's display binding before looking up the requested records: a binding
        // mismatch takes precedence over a missing preset or persona.
        if (!chatRecord.data || chatRecord.revision === null) {
            throw new GenerationRunnerError(404, "The job's chat no longer exists");
        }
        const refusal = checkChatBinding(
            chatRecord.data as Chat,
            bindingLookup(presets, db.modelPresets, db.personas),
            context,
            "display",
        );
        if (refusal) {
            throw new ChatBindingError(refusal);
        }

        const preset = presets.find((record) => record?.id === context.presetId);
        if (!preset) {
            throw new GenerationRunnerError(404, "The job's preset no longer exists");
        }
        const modelPreset = ((db.modelPresets ?? []) as ModelPreset[]).find(
            (record) => record?.id === context.modelPresetId,
        );
        if (!modelPreset) {
            throw new GenerationRunnerError(404, "The job's model preset no longer exists");
        }
        const personas = (db.personas ?? []) as RisuPersona[];
        const personaById = (id: string | null | undefined) => {
            const found = personas.find((record) => record?.id === id);
            if (!found) {
                throw new GenerationRunnerError(404, "The job's persona no longer exists");
            }
            return found;
        };
        const effectivePersona = personaById(context.personaId);

        const modelProfiles = db.modelProfiles as ModelProfile[];
        // Forward this request's prompt, model/profile and persona roots, plus selection indexes.
        forwardSelectedPreset(db, presets, preset, modelPreset, modelProfiles);
        forwardPersonaRoots(db, effectivePersona, personas);

        const characters = characterRecords.map((record) => characterShell(record.data));
        db.characters = characters;
        const owner = characters.find((entry) => entry.chaId === context.characterId);
        if (!owner) {
            throw new GenerationRunnerError(404, "The job's chat no longer exists");
        }
        (owner as unknown as { chats: Chat[] }).chats = [chatRecord.data as Chat];

        const speaker = characters.find((entry) => entry.chaId === context.speakerChaId);
        const request = buildRequestDb(
            [
                single(RESOURCE_KIND.providers),
                single(RESOURCE_KIND.llmSecrets),
                single(RESOURCE_KIND.ui),
                single(RESOURCE_KIND.customModels),
                single(RESOURCE_KIND.credentials),
                single(RESOURCE_KIND.presets),
                single(RESOURCE_KIND.modelPresets),
                single(RESOURCE_KIND.modelProfiles),
                single(RESOURCE_KIND.personas),
            ],
            {
                presetId: preset.id,
                modelPresetId: modelPreset.id,
                personaId: effectivePersona.id,
                selectedPersonaId: effectivePersona.id,
                selectedCharacterId: context.characterId,
                speakerId: context.speakerChaId ?? null,
            },
            { selectedCharacterName: `${owner.name}`, speakerName: speaker ? `${speaker.name}` : null },
        );

        const revisions = new Map<string, string>();
        for (const [kindName, records] of Object.entries({
            ...configuration.value,
            [RESOURCE_KIND.characters]: characterRecords,
        })) {
            for (const record of records) {
                revisions.set(`${kindName}/${record.id}`, record.revision);
            }
        }

        const scope: JobScope = {
            db: db as unknown as Database,
            characterId: context.characterId,
            chatId: context.chatId,
            chatRevision: chatRecord.revision,
            chatSourceGeneration: chatRecord.sourceGeneration,
            revisions,
            characterRevisions,
            charactersKind,
            promptPreset: preset,
            modelPreset,
            modelProfiles,
            effectivePersona,
            request,
        };
        return { scope, entries: [configuration, transcript], identities };
    };

    return {
        load,
        resolveIdentities,
        clear() {
            configurationCache.clear();
            transcriptCache.clear();
            characterIdentities.clear();
        },
        stats: () => ({ configuration: configurationCache.stats(), transcripts: transcriptCache.stats() }),
    };
}
