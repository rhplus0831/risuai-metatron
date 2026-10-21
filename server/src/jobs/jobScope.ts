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
import type { ChatGroupResult, ChatOp } from "../../../shared/chats.ts";
import { LLMFormat, type LLMModel } from "../../../shared/llm.ts";
import { RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import { COLLECTION_KIND, SECTION_KIND } from "../../../shared/sections.ts";
import {
    characterShell,
    forwardPersonaRoots,
    forwardSelectedPreset,
    projectCollections,
    projectSections,
} from "../data/databaseProjection.ts";
import type { ResourceKind, ResourceKindRegistry } from "../data/kinds.ts";
import { isValidResourceId, type ResourceStore, type StoredResource } from "../data/resourceStore.ts";
import { loadRequestDb, type LoadedRequestDb } from "../llm/settings.ts";
import {
    bindingLookup,
    checkChatBinding,
    chatBindingRefusalMessage,
    type ChatBindingMode,
    type ChatBindingRefusal,
} from "./chatBinding.ts";
import { GenerationRunnerError, type RunningJob } from "./generationJobs.ts";

/**
 * What a job reads (the prompt runner's `PromptScope` builds on it), loaded at the job's
 * start and kept apart in two parts:
 *
 * - frozen identity and configuration: `db` (the database projection the CBS evaluator and lore
 *   activation read, assembled as the client's `assembleDatabase` and forwarding layer serve it for
 *   the job's prompt and model presets and personas, with every credential field `""` as in the
 *   client's mirror), the two presets, the profiles and the personas, and `request` (the request
 *   layer's own settings, credentials included).
 *   Settings changed while the job runs do not reach it;
 * - the live overlay: the job's chat and the characters, which `refreshChat` and `refreshCharacter`
 *   read again after the job's own writes and after a callback that may have written.
 *
 * Both stay on the main thread: neither the projection nor `request` is ever sent to Lua or a tab.
 */
export type JobScope = {
    db: Database;
    characterId: string;
    chatId: string;
    /** The chat's revision as last read. */
    chatRevision: string;
    /** The job's prompt preset (`context.presetId`). */
    promptPreset: botPreset;
    /** The job's model preset (`context.modelPresetId`). */
    modelPreset: ModelPreset;
    /** Captured model profiles, shared by the job's main and auxiliary requests. */
    modelProfiles: ModelProfile[];
    /**
     * The job's persona (`context.personaId`): the chat's bound persona (a transform's is its display
     * persona), also the forwarded `db.username` and `db.personaPrompt`. A chat job has no separate
     * selected persona: `context.selectedPersonaId` is not read.
     */
    effectivePersona: RisuPersona;
    request: LoadedRequestDb;
    /**
     * The revision of every record the load read, by `<kind>/<id>` (the chat's is `chatRevision`),
     * from the same synchronous read as the data: the script transform's cache key.
     */
    revisions?: ReadonlyMap<string, string>;
    /** Live character revisions, separate from the load's transform cache key; null means gone. */
    characterRevisions?: Map<string, string | null>;
    /**
     * The characters kind, set by the load: the projection holds only the chat's characters, so a
     * chat read again (`refreshChat`) reads the speakers it gained.
     */
    charactersKind?: ResourceKind;
};

function kindOf(kinds: ResourceKindRegistry, name: string): ResourceKind {
    const kind = kinds.get(name);
    if (!kind) {
        throw new Error(`Unknown resource kind ${name}`);
    }
    return kind;
}

/** The job's ids are not its chat's binding: 409, with the refusal. */
export class ChatBindingError extends GenerationRunnerError {
    readonly refusal: ChatBindingRefusal;
    constructor(refusal: ChatBindingRefusal) {
        super(409, chatBindingRefusalMessage(refusal));
        this.name = "ChatBindingError";
        this.refusal = refusal;
    }
}

/** The resource kinds `loadJobScope` reads: every record of them has its revision in `JobScope.revisions`. */
export function jobScopeKinds(kinds: ResourceKindRegistry): ResourceKind[] {
    const kind = (name: string) => kindOf(kinds, name);
    return [
        ...Object.values(SECTION_KIND).map(kind),
        ...Object.values(COLLECTION_KIND).map(kind),
        kind(RESOURCE_KIND.presets),
        kind(RESOURCE_KIND.modules),
        kind(RESOURCE_KIND.characters),
    ];
}

/**
 * The characters a job reads besides its chat's owner: a group's members, the speaker the job names
 * (`speakerChaId`), and every message's speaker (`saying`: the prompt's and lore's speaker names,
 * CBS's group speaker). No job reads another one, so the load parses none of them.
 */
function chatCharacters(chat: Chat, owner: character | groupChat, context: GenerationContext): string[] {
    const ids = owner.type === "group" ? [...(owner.characters ?? [])] : [];
    if (context.speakerChaId) {
        ids.push(context.speakerChaId);
    }
    for (const message of chat.message ?? []) {
        if (message.saying) {
            ids.push(message.saying);
        }
    }
    return ids;
}

/**
 * The chat's owner, then the characters of `chatCharacters` and of `extra`, read by id (a missing
 * one left out); none when the chat or its owner is gone (the load then fails on the owner).
 */
function readCharacters(
    store: ResourceStore,
    charactersKind: ResourceKind,
    context: GenerationContext,
    chat: unknown,
    extra: ((chat: Chat, owner: character | groupChat) => Iterable<string>) | undefined,
    revisions: Map<string, string | null>,
): StoredResource<unknown>[] {
    const ownerRead = store.readRefs([{ kind: charactersKind, id: context.characterId }]).items[0];
    revisions.set(context.characterId, ownerRead.revision);
    if (!chat || ownerRead.data === null || ownerRead.revision === null) {
        return [];
    }
    const records: StoredResource<unknown>[] = [
        { id: context.characterId, revision: ownerRead.revision, data: ownerRead.data },
    ];
    const owner = ownerRead.data as character | groupChat;
    // An id no record can have (a stray `saying`, say) is one no read finds.
    const ids = new Set<string>();
    for (const id of [...chatCharacters(chat as Chat, owner, context), ...(extra?.(chat as Chat, owner) ?? [])]) {
        if (id !== context.characterId && isValidResourceId(id)) {
            ids.add(id);
        }
    }
    const others = store.readRefs([...ids].map((id) => ({ kind: charactersKind, id }))).items;
    for (const item of others) {
        revisions.set(item.id, item.revision);
        if (item.data !== null && item.revision !== null) {
            records.push({ id: item.id, revision: item.revision, data: item.data });
        }
    }
    return records;
}

/**
 * Reads the job's scope in consecutive synchronous store reads (no await between them, so one
 * committed state). The ids are the ones the client sent: they are checked against the chat's
 * binding first (`binding`, default `send`; `ChatBindingError` 409), then a missing character,
 * chat, prompt or model preset, or persona fails the job (`GenerationRunnerError` 404), never a
 * redirect to another record.
 *
 * Of the characters, only the chat's owner and those `chatCharacters` names are read, plus the ids
 * `characters` returns for the chat and the owner's record (a transform's target sources); a
 * character read later (`refreshCharacter`) joins the projection then.
 */
export function loadJobScope(
    store: ResourceStore,
    kinds: ResourceKindRegistry,
    context: GenerationContext,
    options: {
        binding?: ChatBindingMode;
        characters?: (chat: Chat, owner: character | groupChat) => Iterable<string>;
    } = {},
): JobScope {
    const charactersKind = kindOf(kinds, RESOURCE_KIND.characters);
    const read = store.readKinds(jobScopeKinds(kinds).filter((kind) => kind !== charactersKind));
    const chatRead = store.readRefs([], { chats: [{ characterId: context.characterId, id: context.chatId }] });
    const characterRevisions = new Map<string, string | null>();
    read.kinds[RESOURCE_KIND.characters] = readCharacters(
        store,
        charactersKind,
        context,
        chatRead.chats[0]?.data,
        options.characters,
        characterRevisions,
    );
    const single = (name: string): any => read.kinds[name]?.find((record) => record.id === SINGLETON_RESOURCE_ID)?.data;

    const db: Record<string, unknown> = {};
    projectSections(db, single);
    projectCollections(db, single);
    const presets = (single(RESOURCE_KIND.presets) ?? []) as botPreset[];
    db.botPresets = presets;
    db.modules = single(RESOURCE_KIND.modules) ?? [];

    // The chat and its binding before the records the ids name, so a bound record deleted since the
    // job was created reports the binding problem rather than a missing record.
    const chatRecord = chatRead.chats[0];
    if (!chatRecord?.data || chatRecord.revision === null) {
        throw new GenerationRunnerError(404, "The job's chat no longer exists");
    }
    const refusal = checkChatBinding(
        chatRecord.data as Chat,
        bindingLookup(presets, db.modelPresets, db.personas),
        context,
        options.binding ?? "send",
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
    // The forwarding layer's view for this job: the prompt and derived model/profile roots, the
    // job persona's fields, and the selection indexes.
    forwardSelectedPreset(db, presets, preset, modelPreset, modelProfiles);
    forwardPersonaRoots(db, effectivePersona, personas);

    const characters = (read.kinds[RESOURCE_KIND.characters] ?? []).map((record) => characterShell(record.data));
    db.characters = characters;
    const owner = characters.find((entry) => entry.chaId === context.characterId);
    if (!owner) {
        throw new GenerationRunnerError(404, "The job's chat no longer exists");
    }
    setChats(owner, [chatRecord.data as Chat]);

    const speaker = characters.find((entry) => entry.chaId === context.speakerChaId);
    const request = loadRequestDb(
        store,
        kinds,
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
    for (const [kindName, records] of Object.entries(read.kinds)) {
        for (const record of records) {
            revisions.set(`${kindName}/${record.id}`, record.revision);
        }
    }

    return {
        db: db as unknown as Database,
        characterId: context.characterId,
        chatId: context.chatId,
        chatRevision: chatRecord.revision,
        revisions,
        characterRevisions,
        charactersKind,
        promptPreset: preset,
        modelPreset,
        modelProfiles,
        effectivePersona,
        request,
    };
}

/**
 * Admits the job's plugin provider models: the descriptors the tab registered when it
 * created the job, each under its own id `pluginmodel:::<name>` and as a plugin model whatever
 * format it claims. Model resolution of the job's requests, counts, and assembly reads them from the
 * request projection.
 */
export function admitProviderModels(scope: JobScope, providers: readonly { name: string; model: LLMModel }[]): void {
    const pluginModels = providers
        .filter((entry) => entry.model.id === `pluginmodel:::${entry.name}`)
        .map((entry) => ({ ...structuredClone(entry.model), format: LLMFormat.Plugin }));
    scope.request = { ...scope.request, db: { ...scope.request.db, pluginModels } };
}

/** A projection character's chats (a group's are typed read-only; the projection is the job's own copy). */
function setChats(owner: character | groupChat, chats: Chat[]): void {
    (owner as unknown as { chats: Chat[] }).chats = chats;
}

/** The job's chat in the projection (the one chat its owner carries). */
export function scopeChat(scope: JobScope): Chat | undefined {
    const owner = scope.db.characters.find((entry) => entry?.chaId === scope.characterId);
    return owner?.chats.find((chat) => chat.id === scope.chatId) as Chat | undefined;
}

type PendingChatMeta = { scriptstate?: Record<string, string>; note?: string };
const pendingMeta = new WeakMap<JobScope, PendingChatMeta>();
const jobMetadata = new WeakMap<RunningJob, ReturnType<typeof createChatMetadata>>();

/** A refreshed stored snapshot keeps the job's synchronous setters visible until their flush. */
function overlayChatMeta(scope: JobScope, chat: Chat): void {
    const pending = pendingMeta.get(scope);
    if (!pending) {
        return;
    }
    if (pending.scriptstate) {
        chat.scriptstate = { ...chat.scriptstate, ...pending.scriptstate };
    }
    if (pending.note !== undefined) {
        chat.note = pending.note;
    }
}

/**
 * One metadata batch per job, bound only to its live chat scope. Setters replace the variable map:
 * display copies may share the old map. The microtask runs before another request or abort timer;
 * job output and writes flush synchronously through the registered hook.
 */
function createChatMetadata(job: RunningJob, store: ResourceStore, initialScope: JobScope) {
    let scope = initialScope;
    let scheduled = false;
    let failure: unknown;
    let failed = false;
    let latch: (error: unknown) => unknown = (error) => error;
    const clear = () => {
        pendingMeta.delete(scope);
        job.setPendingFlush?.(null);
    };
    const check = () => {
        if (failed) {
            throw failure;
        }
    };
    const flush = () => {
        check();
        const pending = pendingMeta.get(scope);
        if (!pending) {
            return;
        }
        try {
            // The chat must still exist; the variables need no fresh copy (a `merge` of the keys
            // onto the stored map keeps another writer's variables).
            const exists = refreshChat(store, scope);
            const current = scopeChat(scope);
            // This is its own write, never part of a caller's group or recursively flushed.
            clear();
            if (!exists || !current) {
                return;
            }
            const op: ChatOp & { op: "meta" } = { op: "meta" };
            if (pending.note !== undefined) {
                op.set = { note: pending.note };
            }
            if (pending.scriptstate) {
                op.merge = { scriptstate: pending.scriptstate };
            }
            const ops: ChatOp[] = [op];
            const applied = job.write(() => ({
                chats: [
                    { characterId: scope.characterId, chatId: scope.chatId, baseRevision: scope.chatRevision, ops },
                ],
            }));
            refreshChatAfterWrite(store, scope, ops, applied.chats[0]);
            job.emitRecords({ chats: [{ characterId: scope.characterId, id: scope.chatId }] });
        } catch (error) {
            clear();
            failed = true;
            failure = error;
            failure = latch(error);
            throw failure;
        }
    };
    return {
        check,
        flush,
        bind(next: JobScope) {
            if (scope !== next) {
                flush();
                scope = next;
            }
        },
        queue(patch: PendingChatMeta, onFailure: (error: unknown) => unknown) {
            check();
            const chat = scopeChat(scope);
            if (!chat) {
                return;
            }
            latch = onFailure;
            const pending = pendingMeta.get(scope) ?? {};
            if (patch.scriptstate) {
                pending.scriptstate = { ...pending.scriptstate, ...patch.scriptstate };
                chat.scriptstate = { ...chat.scriptstate, ...patch.scriptstate };
            }
            if (patch.note !== undefined) {
                pending.note = patch.note;
                chat.note = patch.note;
            }
            pendingMeta.set(scope, pending);
            job.setPendingFlush?.(flush);
            if (!scheduled) {
                scheduled = true;
                queueMicrotask(() => {
                    scheduled = false;
                    try {
                        flush();
                    } catch (error) {
                        // Never throw out of a microtask: the latched failure ends the job at its
                        // next fence/explicit flush, including jobs without a registry hook.
                        try {
                            console.error("[Job] Chat metadata flush failed", error);
                        } catch {
                            // A broken logger must not escape the microtask either.
                        }
                    }
                });
            }
        },
    };
}

/** Shared by every live binding of a job; frozen/display bindings must not call this. */
export function chatMetadataFor(job: RunningJob, store: ResourceStore, scope: JobScope) {
    let metadata = jobMetadata.get(job);
    if (!metadata) {
        metadata = createChatMetadata(job, store, scope);
        jobMetadata.set(job, metadata);
    }
    metadata.bind(scope);
    return metadata;
}

/** Flush separately before another own-chat write, snapshot, or terminal revision is built. */
export function flushChatMetadata(job: RunningJob): void {
    jobMetadata.get(job)?.flush();
}

/** A preset-chain pick becomes the job's live scope after the old scope's writes land. */
export function bindChatMetadata(job: RunningJob, scope: JobScope): void {
    jobMetadata.get(job)?.bind(scope);
}

/**
 * Reads the job's chat again with its revision (after a write of the job or a callback that may
 * have written): stored data and revision come together, with the pending metadata laid over that
 * snapshot. Pending values carry no stored revision until their own flush commits.
 * Returns false when the chat is gone.
 */
export function refreshChat(store: ResourceStore, scope: JobScope): boolean {
    if (store.chatRevision(scope.characterId, scope.chatId) === scope.chatRevision && scopeChat(scope)) {
        return true;
    }
    const read = store.readRefs([], { chats: [{ characterId: scope.characterId, id: scope.chatId }] });
    const record = read.chats[0];
    const owner = scope.db.characters.find((entry) => entry?.chaId === scope.characterId);
    if (!owner) {
        return false;
    }
    if (!record?.data || record.revision === null) {
        setChats(owner, []);
        return false;
    }
    setChats(owner, [record.data as Chat]);
    scope.chatRevision = record.revision;
    overlayChatMeta(scope, record.data as Chat);
    if (scope.charactersKind) {
        addSpeakers(store, scope.charactersKind, scope, record.data as Chat);
    }
    return true;
}

/**
 * Adopt an own metadata write without reading unchanged messages. A stale write or a subsequent
 * change needs a full refresh: the stored transcript may no longer be the scope's copy.
 */
export function refreshChatAfterWrite(
    store: ResourceStore,
    scope: JobScope,
    ops: readonly ChatOp[],
    result: ChatGroupResult | undefined,
): boolean {
    const current = scopeChat(scope);
    if (current && result?.revision && !result.stale && ops.every((op) => op.op === "meta")) {
        const record = store.chatMeta(scope.characterId, scope.chatId);
        if (record?.revision === result.revision) {
            const owner = scope.db.characters.find((entry) => entry?.chaId === scope.characterId)!;
            const chat = { ...(record.data as Chat), message: current.message };
            overlayChatMeta(scope, chat);
            setChats(owner, [chat]);
            scope.chatRevision = record.revision;
            return true;
        }
    }
    return refreshChat(store, scope);
}

/**
 * Reads into the projection the message speakers (`saying`) it lacks: a message written since the
 * load (by the job, a script, or another tab) may name a character the load did not read.
 */
function addSpeakers(store: ResourceStore, charactersKind: ResourceKind, scope: JobScope, chat: Chat): void {
    const revisions = (scope.characterRevisions ??= new Map());
    const known = new Set(scope.db.characters.map((entry) => entry?.chaId));
    const missing = new Set<string>();
    for (const message of chat.message ?? []) {
        if (
            message.saying &&
            !known.has(message.saying) &&
            !revisions.has(message.saying) &&
            isValidResourceId(message.saying)
        ) {
            missing.add(message.saying);
        }
    }
    if (missing.size === 0) {
        return;
    }
    for (const item of store.readRefs([...missing].map((id) => ({ kind: charactersKind, id }))).items) {
        revisions.set(item.id, item.revision);
        if (item.data !== null) {
            scope.db.characters.push(characterShell(item.data));
        }
    }
}

/** Reads one character record again into the projection (its chats kept); false when it is gone. */
export function refreshCharacter(
    store: ResourceStore,
    kinds: ResourceKindRegistry,
    scope: JobScope,
    characterId: string,
): boolean {
    const kind = kindOf(kinds, RESOURCE_KIND.characters);
    const revisions = (scope.characterRevisions ??= new Map());
    const index = scope.db.characters.findIndex((entry) => entry?.chaId === characterId);
    const revision = store.revisionOf(kind, characterId);
    if (
        revisions.has(characterId) &&
        revisions.get(characterId) === revision &&
        (revision === null ? index < 0 : index >= 0)
    ) {
        return revision !== null;
    }
    const row = store.get(kind, characterId);
    revisions.set(characterId, row?.revision ?? null);
    if (!row) {
        if (index >= 0) {
            scope.db.characters.splice(index, 1);
        }
        return false;
    }
    const chats = index >= 0 ? scope.db.characters[index].chats : [];
    const next = characterShell(row.data, chats);
    if (index >= 0) {
        scope.db.characters[index] = next;
    } else {
        scope.db.characters.push(next);
    }
    return true;
}
