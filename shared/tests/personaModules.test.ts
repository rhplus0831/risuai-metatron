// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizePersonaModules, normalizePersonas, personaLinksModule, personaModuleIdSet } from "../personas.ts";

// The persona module links (`RisuPersona.modules`): the canonical form both sides store (the
// client's projection must equal the server's normalized text, so the normalizer is a fixed point
// and an entry without the field stays without it), and the link predicate the two resolvers share
// (`getModules` on the tab, `jobModules` on the server): a link matches a stored module by its `id`
// only, never by `namespace`, and never an MCP module.

describe("normalizePersonaModules", () => {
    it("keeps the non-blank strings once each in first-occurrence order, and turns a non-list into []", () => {
        expect(normalizePersonaModules(["b", "a", "b", " ", "", 1, null, undefined, {}, "a"])).toEqual(["b", "a"]);
        for (const input of [undefined, null, "a", 1, { 0: "a", length: 1 }]) {
            expect(normalizePersonaModules(input), JSON.stringify(input)).toEqual([]);
        }
        // An id with inner or outer spaces is kept as given: a trim would change a module's identity.
        expect(normalizePersonaModules([" a ", "a b"])).toEqual([" a ", "a b"]);
    });

    it("is a fixed point and never returns its input", () => {
        const input = ["b", "a"];
        const once = normalizePersonaModules(input);
        expect(once).toEqual(input);
        expect(once).not.toBe(input);
        expect(normalizePersonaModules(once)).toEqual(once);
    });
});

describe("normalizePersonas", () => {
    it("cleans `modules` when the key is present, leaves an entry without it alone, and is a fixed point", () => {
        const out = normalizePersonas([
            { name: "a", id: "11111111-1111-4111-8111-111111111111" },
            { name: "b", id: "22222222-2222-4222-8222-222222222222", modules: ["m", "m", 3, "", " ", "n"] },
            { name: "c", id: "33333333-3333-4333-8333-333333333333", modules: "m" },
            { name: "d", id: "44444444-4444-4444-8444-444444444444", modules: [] },
        ]);
        expect(Object.hasOwn(out[0], "modules")).toBe(false);
        expect(out[1].modules).toEqual(["m", "n"]);
        // A present non-list becomes the empty list rather than being dropped: the key stays.
        expect(out[2].modules).toEqual([]);
        expect(out[3].modules).toEqual([]);
        // The ids were valid, so a second pass changes nothing: the stored text is a fixed point.
        expect(normalizePersonas(JSON.parse(JSON.stringify(out)))).toEqual(out);
    });
});

describe("personaModuleIdSet and personaLinksModule", () => {
    it("links by id only, never by namespace, never an MCP module, and nothing without a persona", () => {
        const linked = personaModuleIdSet({ modules: ["x", "shared-ns", "mcpmod", "x", ""] });
        expect([...linked]).toEqual(["x", "shared-ns", "mcpmod"]);
        expect(personaLinksModule(linked, { id: "x" })).toBe(true);
        // A module whose namespace is a linked text is not linked: the persona names modules, not namespaces.
        expect(personaLinksModule(linked, { id: "other", namespace: "shared-ns" } as { id: string })).toBe(false);
        // An MCP module is never activated through a persona, even when its id is linked.
        expect(personaLinksModule(linked, { id: "mcpmod", mcp: { url: "http://mcp" } })).toBe(false);
        expect(personaLinksModule(linked, { id: "x", mcp: undefined })).toBe(true);
        expect(personaLinksModule(linked, { id: "y" })).toBe(false);
        for (const persona of [null, undefined, {}, { modules: undefined }, { modules: "x" }]) {
            const set = personaModuleIdSet(persona as { modules?: string[] } | null | undefined);
            expect(set.size, JSON.stringify(persona)).toBe(0);
            expect(personaLinksModule(set, { id: "x" })).toBe(false);
        }
    });
});
