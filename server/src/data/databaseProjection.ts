import type {
    ModelPreset,
    ModelProfile,
    RisuPersona,
    botPreset,
    character,
    groupChat,
} from "../../../shared/database.ts";
import { FLAT_SECRET_FIELDS, llmSecretSiblings, NESTED_SECRET_FIELDS } from "../../../shared/llmSecrets.ts";
import { PERSONA_DEFAULTS } from "../../../shared/personas.ts";
import { PERSONA_ROOT_ALIASES } from "../../../shared/presets.ts";
import {
    COLLECTION_FIELDS,
    COLLECTION_KIND,
    COLLECTION_SELECTION_FIELDS,
    type CollectionKind,
    forwardPresetRoots,
    SECTION_FIELDS,
    SECTION_KIND,
    type SectionKind,
} from "../../../shared/sections.ts";

/**
 * The steps that assemble a flat `Database` projection from the resource records, shared by a job's
 * scope (`server/src/jobs/jobScope.ts` `loadJobScope`) and the upstream `.bin` exporter
 * (`server/src/data/upstream/exportDatabase.ts`). Each step writes into `db` and copies no value it
 * does not have to: the projection's containers are the records' own, so a caller that edits the
 * projection in place passes detached records.
 */

/** The client mirror's view of the `llmSecrets` section: its siblings, every credential `""`. */
export function mirrorSecrets(record: Record<string, unknown>): Record<string, unknown> {
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

/**
 * Every section's `SECTION_FIELDS` the record holds, under their `Database` names. `llmSecrets` goes
 * through `mirrorSecrets` (every credential `""`) unless `llmSecrets: "stored"` copies its fields as
 * stored. A missing section record throws.
 */
export function projectSections(
    db: Record<string, unknown>,
    sectionRecord: (section: SectionKind) => unknown,
    options: { llmSecrets?: "mirror" | "stored" } = {},
): void {
    for (const section of Object.values(SECTION_KIND)) {
        const record = sectionRecord(section);
        if (record === undefined) {
            throw new Error(`The server has no ${section} record`);
        }
        const fields =
            section === SECTION_KIND.llmSecrets && options.llmSecrets !== "stored"
                ? mirrorSecrets(record as Record<string, unknown>)
                : (record as Record<string, unknown>);
        for (const field of SECTION_FIELDS[section]) {
            if (Object.hasOwn(fields, field)) {
                db[field] = fields[field];
            }
        }
    }
}

/**
 * Every collection's value under its `Database` name; a `{ items, selectedId }` record is unpacked
 * into its field and its `COLLECTION_SELECTION_FIELDS` name. A missing collection record throws.
 */
export function projectCollections(
    db: Record<string, unknown>,
    collectionRecord: (collection: CollectionKind) => any,
): void {
    for (const collection of Object.values(COLLECTION_KIND)) {
        const record = collectionRecord(collection);
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
}

/**
 * The forwarding layer's view of one prompt preset and model preset: the prompt and derived
 * model/profile roots (`forwardPresetRoots`), and `botPresetsId`, the prompt preset's index (0 when
 * it is not in `presets`).
 */
export function forwardSelectedPreset(
    db: Record<string, unknown>,
    presets: readonly botPreset[],
    preset: botPreset,
    modelPreset: ModelPreset,
    profiles: readonly ModelProfile[],
): void {
    forwardPresetRoots(db, preset as unknown as Record<string, unknown>, modelPreset, profiles);
    db.botPresetsId = Math.max(
        0,
        presets.findIndex((record) => record?.id === preset.id),
    );
}

/**
 * The persona's fields under their root names (`PERSONA_ROOT_ALIASES`; a non-string reads as its
 * `PERSONA_DEFAULTS` value) and `selectedPersona`, its index (0 when it is not in `personas`).
 */
export function forwardPersonaRoots(
    db: Record<string, unknown>,
    persona: RisuPersona,
    personas: readonly RisuPersona[],
): void {
    for (const [rootKey, field] of Object.entries(PERSONA_ROOT_ALIASES)) {
        const value = persona[field as keyof RisuPersona];
        db[rootKey] = typeof value === "string" ? value : PERSONA_DEFAULTS[field as keyof typeof PERSONA_DEFAULTS];
    }
    db.selectedPersona = Math.max(
        0,
        personas.findIndex((record) => record?.id === persona.id),
    );
}

/** A character record as a `Database` character: its stored fields, `chats` and `chatPage`. */
export function characterShell(data: unknown, chats: readonly unknown[] = [], chatPage = 0): character | groupChat {
    return { ...(data as object), chats, chatPage } as unknown as character | groupChat;
}
