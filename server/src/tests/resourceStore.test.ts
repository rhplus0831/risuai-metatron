// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKindRegistry, type ResourceKind } from "../data/kinds.ts";
import {
    createResourceStore,
    ResourceConflictError,
    type ResourceStore,
    ResourceValidationError,
} from "../data/resourceStore.ts";
import { sleep } from "./testSupport.ts";

const root: ResourceKind = { name: "root", schemaVersion: 1, normalize: (input) => input };
const presets: ResourceKind = { name: "presets", schemaVersion: 2, normalize: (input) => input };
const kinds = createKindRegistry([root, presets]);

const stores: ResourceStore[] = [];
const dirs: string[] = [];
afterEach(() => {
    for (const store of stores.splice(0)) {
        store.close();
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});
function memoryStore() {
    const store = createResourceStore({ file: ":memory:", kinds });
    stores.push(store);
    return store;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const conflictWith = (fn: () => unknown, current: string | null, label: string) => {
    let error: unknown;
    try {
        fn();
    } catch (e) {
        error = e;
    }
    expect(error, label).toBeInstanceOf(ResourceConflictError);
    expect((error as ResourceConflictError).current, label).toBe(current);
};

describe("revision tokens", () => {
    it("carries the epoch, incarnation, and write count, and refuses tokens from another epoch or incarnation", () => {
        const store = memoryStore();
        const first = store.put(root, "a", 1, null).revision;
        expect(first).toMatch(/^[0-9a-f-]{36}:1:1$/);
        const second = store.put(root, "a", 2, first).revision;
        expect(second).toBe(first.replace(/:1$/, ":2"));
        expect(store.get(root, "a")).toEqual({ revision: second, data: 2 });

        conflictWith(() => store.put(root, "a", 3, first), second, "stale put");
        const otherEpoch = second.replace(uuid, "00000000-0000-4000-8000-000000000000");
        expect(otherEpoch).not.toBe(second);
        conflictWith(() => store.put(root, "a", 3, otherEpoch), second, "other epoch");
        conflictWith(() => store.delete(root, "a", otherEpoch), second, "other epoch delete");
        for (const token of [
            "",
            "x",
            `${second}:1`,
            second.replace(/:1:2$/, ":01:2"),
            second.replace(/:1:2$/, ":9007199254740993:2"),
        ]) {
            conflictWith(() => store.put(root, "a", 3, token), second, `malformed ${token}`);
        }
        expect(store.get(root, "a")).toEqual({ revision: second, data: 2 });

        // A deleted record is a conflict with `current: null`; a recreated one has a new incarnation.
        store.delete(root, "a", second);
        expect(store.get(root, "a")).toBeNull();
        conflictWith(() => store.delete(root, "a", second), null, "delete missing");
        conflictWith(() => store.put(root, "a", 3, second), null, "put missing");
        const recreated = store.put(root, "a", 3, null).revision;
        expect(recreated).toMatch(/:2:1$/);
        conflictWith(() => store.put(root, "a", 4, second), recreated, "old token after recreate");
        conflictWith(() => store.delete(root, "a", second), recreated, "old token delete after recreate");
        conflictWith(() => store.put(root, "a", 4, null), recreated, "duplicate create");
        expect(store.get(root, "a")).toEqual({ revision: recreated, data: 3 });
    });

    it("keeps data, epoch, and tokens across a reopen, and closes idempotently", () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "risu-resource-store-"));
        dirs.push(dir);
        const file = path.join(dir, "nested", "resources.sqlite");
        const first = createResourceStore({ file, kinds });
        const token = first.put(presets, "p", { name: "one" }, null).revision;
        first.put(root, "r", 1, null);
        first.close();
        first.close();
        expect(() => first.get(root, "r")).toThrow("Resource store is closed");
        expect(() => first.transaction(() => {})).toThrow("Resource store is closed");

        const second = createResourceStore({ file, kinds });
        stores.push(second);
        expect(second.get(presets, "p")).toEqual({ revision: token, data: { name: "one" } });
        expect(second.list(root)).toEqual([{ id: "r", revision: expect.stringMatching(uuid), data: 1 }]);
        const next = second.put(presets, "p", { name: "two" }, token).revision;
        expect(next.slice(0, 36)).toBe(token.slice(0, 36));
        expect(second.get(presets, "p")).toEqual({ revision: next, data: { name: "two" } });
    });
});

describe("kinds", () => {
    it("refuses kind objects the registry does not hold, even with a registered name", () => {
        const store = memoryStore();
        store.put(root, "a", 1, null);
        const impostor: ResourceKind = { name: "root", schemaVersion: 1, normalize: () => "replaced" };
        const foreign: ResourceKind = { name: "characters", schemaVersion: 1, normalize: (input) => input };
        for (const kind of [impostor, foreign]) {
            const message = `Unregistered resource kind: ${kind.name}`;
            expect(() => store.get(kind, "a")).toThrow(message);
            expect(() => store.list(kind)).toThrow(message);
            expect(() => store.put(kind, "a", 2, null)).toThrow(message);
            expect(() => store.delete(kind, "a", "x")).toThrow(message);
        }
        expect(store.get(root, "a")).toEqual({ revision: expect.any(String), data: 1 });
        expect(store.list(root)).toHaveLength(1);
        expect(store.list(presets)).toEqual([]);
    });

    it("lists in creation order and rejects invalid ids", () => {
        const store = memoryStore();
        for (const id of ["c", "a", "b"]) {
            store.put(root, id, id, null);
        }
        store.put(root, "a", "a2", store.get(root, "a")!.revision);
        expect(store.list(root).map((item) => [item.id, item.data])).toEqual([
            ["c", "c"],
            ["a", "a2"],
            ["b", "b"],
        ]);
        for (const id of ["", ".a", "a/b", "a".repeat(129), "가"]) {
            expect(() => store.put(root, id, 1, null), id).toThrow(ResourceValidationError);
            expect(() => store.get(root, id), id).toThrow("Invalid resource id");
        }
    });
});

describe("serialization", () => {
    it("stores the JSON.stringify form and returns it from put and get", () => {
        const store = memoryStore();
        const value = {
            when: new Date(0),
            gone: undefined,
            boxed: new Number(3),
            custom: { toJSON: () => "j" },
            list: [undefined, () => 1, new Number(4)],
        };
        const stored = store.put(root, "v", value, null).data;
        expect(stored).toEqual({ when: "1970-01-01T00:00:00.000Z", boxed: 3, custom: "j", list: [null, null, 4] });
        expect(store.get(root, "v")!.data).toEqual(stored);
        expect(store.list(root)[0].data).toEqual(stored);
    });

    it("refuses values whose JSON form would lose a non-finite number", () => {
        const store = memoryStore();
        const nonFinite: [string, unknown][] = [
            ["Infinity", Infinity],
            ["nested NaN", { a: [NaN] }],
            ["toJSON Infinity", { toJSON: () => Infinity }],
            ["boxed Infinity", new Number(Infinity)],
            ["boxed NaN", { n: new Number(NaN) }],
            ["symbol-coerced Infinity", Object.assign(new Number(1), { [Symbol.toPrimitive]: () => Infinity })],
        ];
        const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;
        if (rawJSON) {
            nonFinite.push(["rawJSON overflow", { n: rawJSON("1e400") }]);
        }
        for (const [label, value] of nonFinite) {
            expect(() => store.put(root, "v", value, null), label).toThrow(
                new ResourceValidationError("Resource data contains a non-finite number"),
            );
        }
        expect(store.get(root, "v")).toBeNull();
    });

    it("refuses values JSON.stringify cannot serialize, including a Number box whose conversion hook returns a bigint", () => {
        const store = memoryStore();
        const cycle: { self?: unknown } = {};
        cycle.self = cycle;
        const unserializable: [string, unknown][] = [
            ["bigint", 1n],
            ["nested bigint", { n: 1n }],
            ["cycle", cycle],
            [
                "throwing getter",
                {
                    get x(): number {
                        throw new Error("boom");
                    },
                },
            ],
            ["valueOf bigint box", Object.assign(new Number(0), { valueOf: () => 9007199254740993n })],
            ["toPrimitive bigint box", Object.assign(new Number(0), { [Symbol.toPrimitive]: () => 9007199254740993n })],
        ];
        for (const [label, value] of unserializable) {
            expect(() => JSON.stringify(value), label).toThrow();
            expect(() => store.put(root, "v", value, null), label).toThrow(
                new ResourceValidationError("Resource data is not serializable as JSON"),
            );
        }
        for (const [label, value] of [
            ["undefined", undefined],
            ["function", () => 1],
            ["symbol", Symbol("s")],
        ] as [string, unknown][]) {
            expect(() => store.put(root, "v", value, null), label).toThrow(
                new ResourceValidationError("Resource data is not JSON"),
            );
        }
        expect(store.get(root, "v")).toBeNull();
    });

    it("allows 256 levels of nesting and refuses 257, judged on the JSON form", () => {
        const store = memoryStore();
        const nested = (depth: number): unknown => (depth === 0 ? 1 : [nested(depth - 1)]);
        expect(store.put(root, "ok", nested(256), null).data).toEqual(nested(256));
        expect(() => store.put(root, "deep", nested(257), null)).toThrow(
            new ResourceValidationError("Resource data is nested deeper than 256 levels"),
        );
        // `toJSON` output counts, not the value handed in.
        expect(() => store.put(root, "deep", { toJSON: () => nested(257) }, null)).toThrow(ResourceValidationError);
        expect(store.get(root, "deep")).toBeNull();
    });

    it("runs the kind's normalizer and stores its result", () => {
        const trimmed: ResourceKind<string> = {
            name: "names",
            schemaVersion: 1,
            normalize(input) {
                if (typeof input !== "string") {
                    throw new ResourceValidationError("Name must be a string");
                }
                return input.trim();
            },
        };
        const store = createResourceStore({ file: ":memory:", kinds: createKindRegistry([trimmed]) });
        stores.push(store);
        expect(() => store.put(trimmed, "n", 1, null)).toThrow(new ResourceValidationError("Name must be a string"));
        expect(store.get(trimmed, "n")).toBeNull();
        const { revision, data } = store.put(trimmed, "n", "  Alice ", null);
        expect(data).toBe("Alice");
        expect(store.get(trimmed, "n")).toEqual({ revision, data: "Alice" });
    });
});

describe("transaction", () => {
    it("commits every write when the body returns and rolls all of them back when it throws", () => {
        const store = memoryStore();
        expect(
            store.transaction(() => {
                store.put(root, "a", 1, null);
                store.put(presets, "p", 2, null);
                return "done";
            }),
        ).toBe("done");
        expect(store.get(root, "a")!.data).toBe(1);
        expect(store.get(presets, "p")!.data).toBe(2);

        expect(() =>
            store.transaction(() => {
                store.put(root, "a", 10, store.get(root, "a")!.revision);
                store.put(root, "b", 3, null);
                throw new Error("body failed");
            }),
        ).toThrow("body failed");
        expect(store.get(root, "a")!.data).toBe(1);
        expect(store.get(root, "b")).toBeNull();
    });

    it("rejects a nested transaction and stays usable afterwards", () => {
        const store = memoryStore();
        expect(() =>
            store.transaction(() => {
                store.put(root, "a", 1, null);
                store.transaction(() => {});
            }),
        ).toThrow("Nested resource transactions are not supported");
        expect(store.get(root, "a")).toBeNull();
        store.transaction(() => store.put(root, "a", 1, null));
        expect(store.get(root, "a")!.data).toBe(1);
    });

    it("refuses to commit after a conflict the body caught", () => {
        const store = memoryStore();
        const existing = store.put(root, "exists", 1, null).revision;
        let caught: unknown;
        conflictWith(
            () =>
                store.transaction(() => {
                    store.put(root, "new", 1, null);
                    try {
                        store.put(root, "exists", 2, null);
                    } catch (error) {
                        caught = error;
                    }
                    store.put(root, "later", 1, null);
                    return "ignored";
                }),
            existing,
            "transaction",
        );
        expect(caught).toBeInstanceOf(ResourceConflictError);
        expect(store.get(root, "new")).toBeNull();
        expect(store.get(root, "later")).toBeNull();
        expect(store.get(root, "exists")).toEqual({ revision: existing, data: 1 });
    });

    it("rolls back a body that returns a promise or a thenable and rejects the continuation's write", async () => {
        const store = memoryStore();
        const late: string[] = [];
        const lateWrite = (id: string) => {
            try {
                store.put(root, id, 2, null);
                late.push(`${id}: wrote`);
            } catch (error) {
                late.push(`${id}: ${(error as Error).message}`);
            }
        };
        const asyncBody = async () => {
            store.put(root, "a", 1, null);
            await Promise.resolve();
            lateWrite("a-late");
        };
        expect(() => store.transaction(asyncBody as unknown as () => void)).toThrow(
            "Resource transactions must be synchronous",
        );

        const thenableBody = () => {
            store.put(root, "b", 1, null);
            return {
                then(_onFulfilled: unknown, onRejected: (reason: unknown) => void) {
                    queueMicrotask(() => {
                        lateWrite("b-late");
                        onRejected(new Error("thenable"));
                    });
                },
            };
        };
        expect(() => store.transaction(thenableBody)).toThrow("Resource transactions must be synchronous");

        await sleep(10);
        expect(late).toEqual([
            "a-late: Resource transaction already ended",
            "b-late: Resource transaction already ended",
        ]);
        for (const id of ["a", "a-late", "b", "b-late"]) {
            expect(store.get(root, id), id).toBeNull();
        }
        // The store is usable after the rollback.
        expect(store.put(root, "a", 1, null).data).toBe(1);
    });

    it("rejects a timer write the body scheduled, even after the commit", async () => {
        const store = memoryStore();
        const late: string[] = [];
        store.transaction(() => {
            store.put(root, "a", 1, null);
            setTimeout(() => {
                try {
                    store.put(root, "timer", 2, null);
                    late.push("wrote");
                } catch (error) {
                    late.push((error as Error).message);
                }
            }, 0);
        });
        expect(store.get(root, "a")!.data).toBe(1);
        await sleep(10);
        expect(late).toEqual(["Resource transaction already ended"]);
        expect(store.get(root, "timer")).toBeNull();
        expect(store.put(root, "timer", 2, null).data).toBe(2);
    });

    it("rolls back when the returned value's `then` getter throws or `then` writes synchronously", () => {
        const store = memoryStore();
        expect(() =>
            store.transaction(() => {
                store.put(root, "a", 1, null);
                return {
                    get then(): unknown {
                        store.put(root, "getter", 2, null);
                        throw new Error("getter");
                    },
                };
            }),
        ).toThrow("getter");
        expect(() =>
            store.transaction(() => {
                store.put(root, "b", 1, null);
                return {
                    then() {
                        store.put(root, "sync", 2, null);
                    },
                };
            }),
        ).toThrow("Resource transactions must be synchronous");
        for (const id of ["a", "getter", "b", "sync"]) {
            expect(store.get(root, id), id).toBeNull();
        }
    });

    it("rejects promise-returning bodies at compile time and accepts never and any", () => {
        const store = memoryStore();
        const compileOnly = () => {
            // @ts-expect-error an async body does not type-check
            store.transaction(async () => 1);
            // @ts-expect-error a body that may return a promise does not type-check
            store.transaction((): number | Promise<number> => 1);
        };
        expect(compileOnly).toBeTypeOf("function");
        expect(() =>
            store.transaction((): never => {
                throw new Error("never");
            }),
        ).toThrow("never");
        const parsed: unknown = store.transaction(() => JSON.parse('{"ok":true}'));
        expect(parsed).toEqual({ ok: true });
        expect(store.transaction(() => {})).toBeUndefined();
    });
});
