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
import { LLMFormat, type LLMModel } from "../../../shared/llm.ts";
import { FLAT_SECRET_FIELDS, llmSecretSiblings, NESTED_SECRET_FIELDS } from "../../../shared/llmSecrets.ts";
import { PERSONA_DEFAULTS } from "../../../shared/personas.ts";
import { PERSONA_ROOT_ALIASES } from "../../../shared/presets.ts";
import { RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import {
    COLLECTION_FIELDS,
    COLLECTION_KIND,
    COLLECTION_SELECTION_FIELDS,
    forwardPresetRoots,
    SECTION_FIELDS,
    SECTION_KIND,
} from "../../../shared/sections.ts";
import type { ResourceKind, ResourceKindRegistry } from "../data/kinds.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import { loadRequestDb, type LoadedRequestDb } from "../llm/settings.ts";
import {
    bindingLookup,
    checkChatBinding,
    chatBindingRefusalMessage,
    type ChatBindingMode,
    type ChatBindingRefusal,
} from "./chatBinding.ts";
import { GenerationRunnerError } from "./generationJobs.ts";

/**
 * What a job reads (Phase 5 slice 8a; the slice 9 `PromptScope` builds on it), loaded at the job's
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
     * from the same synchronous read as the data: the script transform's cache key (slice 13).
     */
    revisions?: ReadonlyMap<string, string>;
};

function kindOf(kinds: ResourceKindRegistry, name: string): ResourceKind {
    const kind = kinds.get(name);
    if (!kind) {
        throw new Error(`Unknown resource kind ${name}`);
    }
    return kind;
}

/** The client mirror's view of the `llmSecrets` section: its siblings, every credential `""`. */
function mirrorSecrets(record: Record<string, unknown>): Record<string, unknown> {
    const fields = SECTION_FIELDS.llmSecrets as readonly string[];
    const out = llmSecretSiblings(record, fields);
    for (const field of FLAT_SECRET_FIELDS) {
        if (fields.includes(field)) {
            out[field] = "";
        }
    }
    for (const [field, leaf] of Object.entries(NESTED_SECRET_FIELDS)) {
        out[field] = { ...((out[field] as object) ?? {}), [leaf]: "" };
    }
    out.OaiCompAPIKeys = {};
    return out;
}

/** The job's ids are not its chat's binding (`docs/plan/chat-binding.md`): 409, with the refusal. */
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
 * Reads the job's scope in consecutive synchronous store reads (no await between them, so one
 * committed state). The ids are the ones the client sent: they are checked against the chat's
 * binding first (`binding`, default `send`; `ChatBindingError` 409), then a missing character,
 * chat, prompt or model preset, or persona fails the job (`GenerationRunnerError` 404), never a
 * redirect to another record.
 */
export function loadJobScope(
    store: ResourceStore,
    kinds: ResourceKindRegistry,
    context: GenerationContext,
    options: { binding?: ChatBindingMode } = {},
): JobScope {
    const read = store.readKinds(jobScopeKinds(kinds));
    const chatRead = store.readRefs([], { chats: [{ characterId: context.characterId, id: context.chatId }] });
    const single = (name: string): any => read.kinds[name]?.find((record) => record.id === SINGLETON_RESOURCE_ID)?.data;

    const db: Record<string, unknown> = {};
    for (const section of Object.values(SECTION_KIND)) {
        const record = single(section);
        if (record === undefined) {
            throw new Error(`The server has no ${section} record`);
        }
        const fields = section === SECTION_KIND.llmSecrets ? mirrorSecrets(record) : record;
        for (const field of SECTION_FIELDS[section]) {
            if (Object.hasOwn(fields, field)) {
                db[field] = (fields as Record<string, unknown>)[field];
            }
        }
    }
    for (const collection of Object.values(COLLECTION_KIND)) {
        const record = single(collection);
        if (record === undefined) {
            throw new Error(`The server has no ${collection} record`);
        }
        if (Object.hasOwn(COLLECTION_SELECTION_FIELDS, collection)) {
            db[COLLECTION_FIELDS[collection]] = record.items;
            db[COLLECTION_SELECTION_FIELDS[collection as keyof typeof COLLECTION_SELECTION_FIELDS]] = record.selectedId;
        } else {
            db[COLLECTION_FIELDS[collection]] = record;
        }
    }
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
    forwardPresetRoots(db, preset as unknown as Record<string, unknown>, modelPreset, modelProfiles);
    db.botPresetsId = Math.max(
        0,
        presets.findIndex((record) => record?.id === preset.id),
    );
    for (const [rootKey, field] of Object.entries(PERSONA_ROOT_ALIASES)) {
        const value = effectivePersona[field as keyof RisuPersona];
        db[rootKey] = typeof value === "string" ? value : PERSONA_DEFAULTS[field as keyof typeof PERSONA_DEFAULTS];
    }
    db.selectedPersona = Math.max(
        0,
        personas.findIndex((record) => record?.id === effectivePersona.id),
    );

    const characters = (read.kinds[RESOURCE_KIND.characters] ?? []).map(
        (record) => ({ ...(record.data as object), chats: [], chatPage: 0 }) as unknown as character | groupChat,
    );
    db.characters = characters;
    const owner = characters.find((entry) => entry.chaId === context.characterId);
    if (!owner) {
        throw new GenerationRunnerError(404, "The job's chat no longer exists");
    }
    setChats(owner, [chatRecord.data as Chat]);

    const request = loadRequestDb(store, kinds, {
        presetId: preset.id,
        modelPresetId: modelPreset.id,
        personaId: effectivePersona.id,
        selectedPersonaId: effectivePersona.id,
        selectedCharacterId: context.characterId,
        speakerId: context.speakerChaId ?? null,
    });

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
        promptPreset: preset,
        modelPreset,
        modelProfiles,
        effectivePersona,
        request,
    };
}

/**
 * Admits the job's plugin provider models (slice 11b): the descriptors the tab registered when it
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

/**
 * Reads the job's chat again with its revision (after a write of the job or a callback that may
 * have written): data and revision always come together, so an old copy never carries a new token.
 * Returns false when the chat is gone.
 */
export function refreshChat(store: ResourceStore, scope: JobScope): boolean {
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
    return true;
}

/** Reads one character record again into the projection (its chats kept); false when it is gone. */
export function refreshCharacter(
    store: ResourceStore,
    kinds: ResourceKindRegistry,
    scope: JobScope,
    characterId: string,
): boolean {
    const row = store.get(kindOf(kinds, RESOURCE_KIND.characters), characterId);
    const index = scope.db.characters.findIndex((entry) => entry?.chaId === characterId);
    if (!row) {
        if (index >= 0) {
            scope.db.characters.splice(index, 1);
        }
        return false;
    }
    const chats = index >= 0 ? scope.db.characters[index].chats : [];
    const next = { ...(row.data as object), chats, chatPage: 0 } as unknown as character | groupChat;
    if (index >= 0) {
        scope.db.characters[index] = next;
    } else {
        scope.db.characters.push(next);
    }
    return true;
}
