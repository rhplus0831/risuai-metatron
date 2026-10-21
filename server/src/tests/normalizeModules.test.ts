// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ModuleShapeError, normalizeModule, upgradeLorebook } from "../../../shared/modules.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { normalizeModules } from "../data/normalize/modules.ts";
import { ResourceValidationError } from "../data/resourceStore.ts";

// The shared module rule (`normalizeModule`, a shape check that refuses a malformed supplied
// structure and never drops one), the server's `modules` normalizer that applies it per entry and
// returns a valid list unchanged, and the pure old-lorebook conversion the import paths run
// (`upgradeLorebook`).

describe("normalizeModule", () => {
    it("refuses a non-object, a non-string name or description, and a present non-list lorebook, regex, or trigger", () => {
        for (const input of [
            null,
            "m",
            [],
            { name: 1 },
            { description: {} },
            { lorebook: {} },
            { regex: "r" },
            { trigger: 1 },
        ]) {
            expect(() => normalizeModule(input), JSON.stringify(input)).toThrow(ModuleShapeError);
        }
        expect(() => normalizeModule({ id: 5 }, () => "new")).toThrow(ModuleShapeError);
    });

    it("returns the input itself, every field kept; with newId a missing id is assigned on a copy", () => {
        const module = { id: "m", name: "M", lorebook: [{ content: "<char>" }], custom: { x: 1 } };
        expect(normalizeModule(module)).toBe(module);
        expect(normalizeModule(module, () => "unused")).toBe(module);
        const idless = JSON.parse('{"name":"N","__proto__":"kept"}');
        const assigned = normalizeModule(idless, () => "new-id") as any;
        expect(assigned).not.toBe(idless);
        expect(assigned.id).toBe("new-id");
        expect(Object.hasOwn(assigned, "__proto__")).toBe(true);
        expect(idless).not.toHaveProperty("id");
        // The server checks without assigning: an id-less module is kept as it is.
        expect(normalizeModule(idless)).toBe(idless);
    });
});

describe("the modules normalizer", () => {
    it("returns a valid list unchanged and refuses a malformed module by its index", () => {
        const list = [{ id: "a", name: "A", lorebook: [{ content: "<char> @@end" }] }, { id: "b" }];
        expect(normalizeModules(list)).toBe(list);
        expect(JSON.stringify(normalizeModules(list))).toBe(JSON.stringify(list));
        expect(() => normalizeModules([{ id: "a" }, { id: "b", lorebook: "x" }])).toThrow(
            new ResourceValidationError("modules[1]: a module's lorebook must be a list"),
        );
        expect(() => normalizeModules([{ id: "a" }, 7])).toThrow(ResourceValidationError);
        expect(() => normalizeModules({})).toThrow(ResourceValidationError);
    });

    it("is the registered modules kind", () => {
        const kind = createKindRegistry(DEFAULT_RESOURCE_KINDS).get("modules")!;
        expect(() => kind.normalize([{ id: "a", regex: {} }], { id: "main" })).toThrow(ResourceValidationError);
        expect(kind.normalize([{ id: "a" }], { id: "main" })).toEqual([{ id: "a" }]);
    });
});

describe("upgradeLorebook", () => {
    it("converts entries below version 2 on copies, keeps the others, and is idempotent", () => {
        const old = { comment: "c", content: "<char> and <bot> meet <user>\n@@@end", activationPercent: 40 };
        const current = { comment: "d", content: "<char>", bookVersion: 2 };
        const noContent = { comment: "e" };
        const input = [old, current, noContent];
        const upgraded = upgradeLorebook(input) as any[];
        expect(upgraded[0]).toEqual({
            comment: "c",
            content: "@@probability 40\n{{char}} and {{char}} meet {{user}}\n@@depth 0",
            activationPercent: null,
            bookVersion: 2,
        });
        expect(upgraded[1]).toBe(current);
        expect(upgraded[2]).toBe(noContent);
        expect(old.content).toBe("<char> and <bot> meet <user>\n@@@end");
        expect(upgradeLorebook(upgraded)).toEqual(upgraded);
    });

    it("refuses a non-object entry", () => {
        expect(() => upgradeLorebook([{ content: "a" }, null])).toThrow(
            new ModuleShapeError("lorebook[1] must be an object"),
        );
    });
});
