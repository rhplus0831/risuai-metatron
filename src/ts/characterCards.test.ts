import { expect, test, vi } from "vitest";
import { createBaseV3 } from "./characterCards";
import type { character } from "./storage/database.svelte";

// Importing the real store module runs rune effects over the records and the selection; nothing under test reads it.
vi.mock(import("src/ts/stores.svelte"), () => ({}) as unknown as typeof import("src/ts/stores.svelte"));

// CharacterJS (`virtualscript`) was removed. Stale keys can still sit on a stored
// character or inside its raw `extentions` (generic plugin/DB APIs accept any key),
// so the exporter must never carry them into a card.
function staleCharacter(): character {
    return {
        name: "stale",
        globalLore: [],
        customscript: [],
        triggerscript: [],
        virtualscript: "alert(1)",
        extentions: {
            risuai: { virtualscript: "alert(2)" },
            keep: { value: 1 },
        },
    } as unknown as character;
}

// The completion notification's custom message is local to this server: the exporter's explicit
// field list never carries it into a card.
test("createBaseV3 does not export customNotificationMessage", () => {
    const card = createBaseV3({ ...staleCharacter(), customNotificationMessage: "Dinner is ready" } as character);
    expect(JSON.stringify(card)).not.toContain("customNotificationMessage");
    expect(JSON.stringify(card)).not.toContain("Dinner is ready");
});

test("createBaseV3 does not export a stale virtualscript", () => {
    const card = createBaseV3(staleCharacter());
    const risuai = card.data.extensions.risuai as Record<string, unknown>;

    expect(risuai).not.toHaveProperty("virtualscript");
    expect(card.data.extensions).toHaveProperty("keep", { value: 1 });
    expect(JSON.stringify(card)).not.toContain("virtualscript");
});
