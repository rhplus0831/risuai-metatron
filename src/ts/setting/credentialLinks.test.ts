// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { scrollToCredential } from "./credentialLinks";

// Open bug fixes plan slice C8: a credential link opens the owning page, which scrolls to the field it
// revealed (`scrollToCredential`); the keyboard focus moves into that field.

afterEach(() => {
    document.body.replaceChildren();
});

describe("scrollToCredential", () => {
    it("scrolls the field's wrapper into view and focuses its input", async () => {
        const link = document.createElement("button");
        const wrapper = document.createElement("div");
        wrapper.dataset.credential = "supaMemoryKey";
        const label = document.createElement("span");
        const input = document.createElement("input");
        const replace = document.createElement("button");
        wrapper.append(label, input, replace);
        document.body.append(link, wrapper);
        link.focus();
        const scrollIntoView = vi.fn();
        wrapper.scrollIntoView = scrollIntoView;
        const focus = vi.spyOn(input, "focus");

        await scrollToCredential("supaMemoryKey");

        expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(document.activeElement).toBe(input);
    });

    it("does nothing when the owner shows no such field", async () => {
        const other = document.createElement("input");
        document.body.append(other);
        other.focus();
        await scrollToCredential("NAIApiKey");
        expect(document.activeElement).toBe(other);
    });
});
