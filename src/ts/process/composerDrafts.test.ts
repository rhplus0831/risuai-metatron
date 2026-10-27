import { describe, expect, it } from "vitest";
import { createComposer } from "./composerDrafts.svelte";

// The chat screen's per-chat composer (`composerDrafts.svelte.ts`): the text, the translation
// draft, and the queued attachments stay with the chat they were typed in across chat switches,
// and a write that lands after an await (a slash command, a pasted image, the file button, a send
// recovery) goes to the chat captured before it, wherever that chat's draft lives now. Before, one
// component state served every chat: typed text carried over to the next chat, and a late write
// landed in whichever chat was selected then.

const a = "c\u0000a";
const b = "c\u0000b";

describe("createComposer", () => {
    it("keeps each chat's text, translation draft, and attachments across switches; a chat not typed in starts empty", () => {
        const composer = createComposer();
        composer.switchTo(a);
        composer.input = "typed in A";
        composer.translate = "A's translation";
        composer.files.push("asset-a");

        composer.switchTo(b);
        expect([composer.input, composer.translate, composer.files]).toEqual(["", "", []]);
        composer.input = "typed in B";

        composer.switchTo(a);
        expect([composer.input, composer.translate, composer.files]).toEqual([
            "typed in A",
            "A's translation",
            ["asset-a"],
        ]);
        // Edits after the return belong to A alone.
        composer.files.splice(0, 1);
        composer.switchTo(b);
        expect([composer.input, composer.files]).toEqual(["typed in B", []]);
        composer.switchTo(a);
        expect(composer.files).toEqual([]);
    });

    it("leaving a chat (to another, or to none) stashes its draft; switching to the shown chat again changes nothing", () => {
        const composer = createComposer();
        composer.switchTo(a);
        composer.input = "kept while away";
        composer.switchTo(null);
        expect(composer.input).toBe("");
        composer.input = "typed with no chat";
        composer.switchTo(a);
        expect(composer.input).toBe("kept while away");
        composer.switchTo(a);
        expect(composer.input).toBe("kept while away");
        // The draft typed with no chat shown is stashed under no chat: gone.
        composer.switchTo(null);
        expect(composer.input).toBe("");
    });

    it("at(key) is the live composer while that chat is shown, and its stashed draft after a switch", () => {
        const composer = createComposer();
        composer.switchTo(a);
        const draft = composer.at(a);
        draft.input = "/command";
        expect(composer.input).toBe("/command");

        // The chat switched while A's send awaited its command: A's late clear and B's composer are apart.
        composer.switchTo(b);
        composer.input = "typed in B";
        expect(draft.input).toBe("/command");
        draft.input = "";
        draft.files.push("pasted-into-a");
        draft.translate = "late translation";
        expect([composer.input, composer.translate, composer.files]).toEqual(["typed in B", "", []]);

        composer.switchTo(a);
        expect([composer.input, composer.translate, composer.files]).toEqual([
            "",
            "late translation",
            ["pasted-into-a"],
        ]);
        // The view follows the draft back into the live composer.
        draft.input += " more";
        expect(composer.input).toBe(" more");
        draft.files = [];
        expect(composer.files).toEqual([]);
    });

    it("a write to a chat never shown yet creates its draft, shown when that chat is", () => {
        const composer = createComposer();
        composer.switchTo(a);
        expect(composer.at(b).input).toBe("");
        composer.at(b).input = "restored into B";
        composer.at(b).files.push("b-asset");
        expect(composer.input).toBe("");
        composer.switchTo(b);
        expect([composer.input, composer.files]).toEqual(["restored into B", ["b-asset"]]);
    });
});
