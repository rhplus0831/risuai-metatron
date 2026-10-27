import { describe, expect, it } from "vitest";

import {
    MESSAGE_EDIT_POPUP_LENGTH_THRESHOLD,
    shouldAutoPopupMessageEditor,
    shouldAutoPopupTranslationEditor,
    shouldUseStableMessageEditor,
} from "./messageEditPopup";

describe("message editor popup rules", () => {
    it("auto-opens the popup for a stored row's open editor unless the setting turns it off", () => {
        expect(shouldAutoPopupMessageEditor({ editMode: true, index: 0 })).toBe(true);
        expect(shouldAutoPopupMessageEditor({ editMode: true, index: 3, disableAutoPopupMessageEditor: false })).toBe(
            true,
        );
        expect(shouldAutoPopupMessageEditor({ editMode: false, index: 0 })).toBe(false);
        // The greeting row (idx -1) is not a stored message.
        expect(shouldAutoPopupMessageEditor({ editMode: true, index: -1 })).toBe(false);
        expect(shouldAutoPopupMessageEditor({ editMode: true, index: 0, disableAutoPopupMessageEditor: true })).toBe(
            false,
        );
    });

    it("suppresses the translation popup after a popup-driven save until translation edit mode is left", () => {
        expect(shouldAutoPopupTranslationEditor({ editTranslationMode: true, index: 0 })).toBe(true);
        expect(
            shouldAutoPopupTranslationEditor({
                editTranslationMode: true,
                index: 0,
                suppressAutoPopupTranslationEditor: true,
            }),
        ).toBe(false);
        expect(
            shouldAutoPopupTranslationEditor({
                editTranslationMode: true,
                index: 0,
                disableAutoPopupMessageEditor: true,
            }),
        ).toBe(false);
        expect(shouldAutoPopupTranslationEditor({ editTranslationMode: false, index: 0 })).toBe(false);
    });

    it("keeps a fixed inline height for long or multi-line text outside the compact themes", () => {
        const long = "x".repeat(MESSAGE_EDIT_POPUP_LENGTH_THRESHOLD + 1);
        const atThreshold = "x".repeat(MESSAGE_EDIT_POPUP_LENGTH_THRESHOLD);
        expect(shouldUseStableMessageEditor({ editMode: true, index: 0, message: "one\ntwo" })).toBe(true);
        expect(shouldUseStableMessageEditor({ editMode: true, index: 0, message: long })).toBe(true);
        expect(shouldUseStableMessageEditor({ editMode: true, index: 0, message: atThreshold })).toBe(false);
        expect(shouldUseStableMessageEditor({ editMode: true, index: 0, message: "short" })).toBe(false);
        expect(shouldUseStableMessageEditor({ editMode: false, index: 0, message: long })).toBe(false);
        expect(shouldUseStableMessageEditor({ editMode: true, index: -1, message: long })).toBe(false);
        for (const theme of ["cardboard", "customHTML", "mobilechat"]) {
            expect(shouldUseStableMessageEditor({ editMode: true, index: 0, message: long, theme }), theme).toBe(false);
        }
        expect(shouldUseStableMessageEditor({ editMode: true, index: 0, message: long, theme: "standard" })).toBe(true);
    });
});
