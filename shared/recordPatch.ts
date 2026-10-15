import type { RecordItemFieldPatch } from "./resources.ts";
import { isPlainObject } from "./valueKinds.ts";

/**
 * The record patch helpers the store and the client share (`RecordFieldPatch`, `RecordItemPatch` in
 * `shared/resources.ts`): the item-id rule of an array record, the item patch's shape check and
 * application, and the JSON diffs a change-feed patch is built from.
 */

/** A record patch that cannot apply: a malformed patch, or a base it does not fit. */
export class RecordPatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RecordPatchError";
    }
}

/**
 * The ids of an item list, in order, when every element is a plain object with an own non-empty
 * string `id` and no id repeats; null otherwise (such a record is written whole).
 */
export function itemIds(list: unknown): string[] | null {
    if (!Array.isArray(list)) {
        return null;
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < list.length; index += 1) {
        const item: unknown = list[index];
        if (!isPlainObject(item) || !Object.hasOwn(item, "id")) {
            return null;
        }
        const id = item.id;
        if (typeof id !== "string" || id === "" || seen.has(id)) {
            return null;
        }
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

/** A field patch's fields, checked: `set` entries and `remove` names, none twice, no `__proto__`. */
export type CheckedFields = { set: [string, unknown][]; remove: string[] };

/** An item patch, checked (`checkItemPatch`). `order` null: the base's ids and order are kept. */
export type CheckedItemPatch = {
    items: Record<string, unknown>[];
    changes: ({ id: string } & CheckedFields)[];
    order: string[] | null;
};

/**
 * Checks one field patch's `set` and `remove` (`what` names it in the message). `forbidden` fields may
 * not be named (an item's `id`). Refuses an empty patch, a field named twice, and `__proto__`.
 */
export function checkFields(
    set: unknown,
    remove: unknown,
    what: string,
    forbidden: readonly string[] = [],
): CheckedFields {
    const fieldsSet = set ?? {};
    const fieldsRemoved = remove ?? [];
    if (
        !isPlainObject(fieldsSet) ||
        !Array.isArray(fieldsRemoved) ||
        !fieldsRemoved.every((field) => typeof field === "string")
    ) {
        throw new RecordPatchError(`${what} is { set?: object, remove?: string[] }`);
    }
    const entries = Object.entries(fieldsSet);
    const fields = [...entries.map(([field]) => field), ...(fieldsRemoved as string[])];
    if (fields.length === 0) {
        throw new RecordPatchError(`${what} names no field`);
    }
    if (new Set(fields).size !== fields.length || fields.includes("__proto__")) {
        throw new RecordPatchError(`${what} names a field twice or names __proto__`);
    }
    const named = forbidden.find((field) => fields.includes(field));
    if (named !== undefined) {
        throw new RecordPatchError(`${what} names ${named}`);
    }
    return { set: entries, remove: [...(fieldsRemoved as string[])] };
}

/**
 * Checks an item patch (`{ items?, changes?, order? }`): `items` are plain objects with an own
 * non-empty string `id`; `changes` are `{ id, set?, remove? }` field patches that do not name `id`; no
 * id appears in both or twice; `order` is absent or a list of distinct strings. A patch that changes
 * nothing and has no `order` is refused.
 */
export function checkItemPatch(patch: Record<string, unknown>): CheckedItemPatch {
    const items = patch.items ?? [];
    const changes = patch.changes ?? [];
    const order = patch.order;
    if (!Array.isArray(items) || !Array.isArray(changes)) {
        throw new RecordPatchError("an item patch is { items?: object[], changes?: object[], order?: string[] }");
    }
    const ids = new Set<string>();
    const claim = (id: unknown, what: string): string => {
        if (typeof id !== "string" || id === "") {
            throw new RecordPatchError(`${what} has no id`);
        }
        if (ids.has(id)) {
            throw new RecordPatchError(`an item patch names the item ${JSON.stringify(id)} twice`);
        }
        ids.add(id);
        return id;
    };
    const checkedItems = items.map((item, index) => {
        if (!isPlainObject(item) || !Object.hasOwn(item, "id")) {
            throw new RecordPatchError(`items[${index}] is not an object with an id`);
        }
        claim(item.id, `items[${index}]`);
        return item;
    });
    const checkedChanges = changes.map((change, index) => {
        const what = `changes[${index}]`;
        if (!isPlainObject(change)) {
            throw new RecordPatchError(`${what} is { id, set?, remove? }`);
        }
        const id = claim(change.id, what);
        return { id, ...checkFields(change.set, change.remove, what, ["id"]) };
    });
    let checkedOrder: string[] | null = null;
    if (order !== undefined) {
        if (!Array.isArray(order) || !order.every((id) => typeof id === "string")) {
            throw new RecordPatchError("an item patch's order is a list of ids");
        }
        if (new Set(order).size !== order.length) {
            throw new RecordPatchError("an item patch's order names an id twice");
        }
        checkedOrder = [...(order as string[])];
    }
    if (checkedItems.length === 0 && checkedChanges.length === 0 && checkedOrder === null) {
        throw new RecordPatchError("an item patch changes nothing");
    }
    return { items: checkedItems, changes: checkedChanges, order: checkedOrder };
}

/** A copy of `record` with the `set` fields assigned and the `remove` fields deleted (no `__proto__`). */
export function withFields(
    record: Record<string, unknown>,
    set: readonly (readonly [string, unknown])[],
    remove: readonly string[],
): Record<string, unknown> {
    const next: Record<string, unknown> = { ...record };
    for (const [field, value] of set) {
        next[field] = value;
    }
    for (const field of remove) {
        delete next[field];
    }
    return next;
}

/**
 * Applies a checked item patch to the base list: refuses a base without unique item ids
 * (`itemIds`), a change of an id the base lacks, an item that is not in the base when there is no
 * `order`, and an `order` that leaves out a patched item or names an id nothing resolves.
 */
export function applyItemPatch(base: unknown, patch: CheckedItemPatch): Record<string, unknown>[] {
    const ids = itemIds(base);
    if (!ids) {
        throw new RecordPatchError("the record's items have no unique ids");
    }
    const list = base as Record<string, unknown>[];
    const byId = new Map(ids.map((id, index) => [id, list[index]]));
    const resolved = new Map(byId);
    for (const item of patch.items) {
        const id = item.id as string;
        if (patch.order === null && !byId.has(id)) {
            throw new RecordPatchError(`the item ${JSON.stringify(id)} is not in the record`);
        }
        resolved.set(id, item);
    }
    for (const change of patch.changes) {
        const item = byId.get(change.id);
        if (!item) {
            throw new RecordPatchError(`the item ${JSON.stringify(change.id)} is not in the record`);
        }
        resolved.set(change.id, withFields(item, change.set, change.remove));
    }
    if (patch.order === null) {
        return ids.map((id) => resolved.get(id)!);
    }
    const ordered = new Set(patch.order);
    for (const id of [...patch.items.map((item) => item.id as string), ...patch.changes.map((change) => change.id)]) {
        if (!ordered.has(id)) {
            throw new RecordPatchError(`the patched item ${JSON.stringify(id)} is not in the order`);
        }
    }
    return patch.order.map((id) => {
        const item = resolved.get(id);
        if (!item) {
            throw new RecordPatchError(`the order names the unknown item ${JSON.stringify(id)}`);
        }
        return item;
    });
}

/**
 * The top-level fields whose JSON value differs from `old` to `next` (own keys only; the same value
 * by reference is equal without serializing it): `set` holds
 * `next`'s values, `remove` the fields `next` lacks. Null when `__proto__` changed (a patch never
 * names it).
 */
export function diffFields(
    old: Record<string, unknown>,
    next: Record<string, unknown>,
): { set: Record<string, unknown>; remove: string[] } | null {
    const set: Record<string, unknown> = {};
    const remove: string[] = [];
    for (const field of new Set([...Object.keys(old), ...Object.keys(next)])) {
        if (!Object.hasOwn(next, field)) {
            remove.push(field);
            continue;
        }
        if (
            Object.hasOwn(old, field) &&
            (Object.is(old[field], next[field]) || JSON.stringify(old[field]) === JSON.stringify(next[field]))
        ) {
            continue;
        }
        if (field === "__proto__") {
            return null;
        }
        set[field] = next[field];
    }
    return remove.includes("__proto__") ? null : { set, remove };
}

/**
 * The item change from `old` to `next` (both lists with unique item ids, else null): an item that is
 * new, or whose `__proto__` changed, goes whole in `items`; another changed item as a field patch in
 * `changes`; `order` when the id sequence differs.
 */
export function diffItems(
    old: unknown,
    next: unknown,
): { items: Record<string, unknown>[]; changes: RecordItemFieldPatch[]; order?: string[] } | null {
    const oldIds = itemIds(old);
    const nextIds = itemIds(next);
    if (!oldIds || !nextIds) {
        return null;
    }
    const oldById = new Map(oldIds.map((id, index) => [id, (old as Record<string, unknown>[])[index]]));
    const items: Record<string, unknown>[] = [];
    const changes: RecordItemFieldPatch[] = [];
    (next as Record<string, unknown>[]).forEach((item, index) => {
        const id = nextIds[index];
        const before = oldById.get(id);
        const fields = before ? diffFields(before, item) : null;
        if (!fields) {
            items.push(item);
        } else if (Object.keys(fields.set).length > 0 || fields.remove.length > 0) {
            changes.push({ id, ...fields });
        }
    });
    const reordered = oldIds.length !== nextIds.length || oldIds.some((id, index) => id !== nextIds[index]);
    return reordered ? { items, changes, order: nextIds } : { items, changes };
}
