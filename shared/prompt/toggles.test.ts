import { describe, expect, it } from "vitest";
import { parseToggleSyntax, resolveGlobalChatVar } from "./toggles.ts";

describe("prompt toggle syntax and resolution", () => {
    it("parses value kinds, indexed select options, and valueless layout rows", () => {
        expect(
            parseToggleSyntax(
                [
                    "flag=Checkbox",
                    "custom=Unknown kind=custom",
                    "mode=Mode=select=First,Second",
                    "title=Title=text",
                    "notes=Notes=textarea",
                    "section=Section=group",
                    "end=End=groupEnd",
                    "rule=Rule=divider",
                    "help=Help=caption",
                    "",
                    "malformed",
                    "=No key",
                    "noLabel=",
                ].join("\n"),
            ),
        ).toMatchObject([
            { key: "flag", value: "Checkbox", type: undefined },
            { key: "custom", value: "Unknown kind", type: undefined },
            { key: "mode", value: "Mode", type: "select", options: ["First", "Second"] },
            { key: "title", value: "Title", type: "text" },
            { key: "notes", value: "Notes", type: "textarea" },
            { key: "section", value: "Section", type: "group", children: [] },
            { key: "end", value: "End", type: "groupEnd" },
            { key: "rule", value: "Rule", type: "divider" },
            { key: "help", value: "Help", type: "caption" },
        ]);
    });

    it("keeps keyless group, groupEnd and divider rows and captions only with a label", () => {
        expect(
            parseToggleSyntax(
                [
                    "=Style=group",
                    "a=A",
                    "==groupEnd",
                    "==divider",
                    "=Section=divider",
                    "=Help text=caption",
                    "==caption",
                    "named=Named=group",
                    "b=B",
                    "==groupEnd",
                ].join("\n"),
            ),
        ).toEqual([
            { key: "", value: "Style", type: "group", children: [] },
            { key: "a", value: "A", type: undefined, options: [] },
            { key: "", value: "", type: "groupEnd" },
            { key: "", value: "", type: "divider" },
            { key: "", value: "Section", type: "divider" },
            { key: "", value: "Help text", type: "caption" },
            { key: "named", value: "Named", type: "group", children: [] },
            { key: "b", value: "B", type: undefined, options: [] },
            { key: "", value: "", type: "groupEnd" },
        ]);
    });

    it("defaults only defined value toggles and lets the first value definition choose the kind", () => {
        const definitions = [
            "flag=Flag",
            "mode=Mode=select=First,Second",
            "text=Text=text",
            "area=Area=textarea",
            "custom=Custom=unknown",
            "section=Section=group",
            "end=End=groupEnd",
            "rule=Rule=divider",
            "help=Help=caption",
            "text=Later checkbox",
            "flag=Later text=text",
            "help=Actual value=textarea",
        ].join("\n");
        const keys = ["flag", "mode", "text", "area", "custom", "section", "end", "rule", "help", "missing"];
        // Missing maps and persisted unset sentinels all have the same kind defaults.
        for (const unset of [undefined, null, "null"]) {
            const chat = Object.fromEntries(keys.map((key) => [`toggle_${key}`, unset]));
            expect(keys.map((key) => resolveGlobalChatVar(`toggle_${key}`, chat, {}, definitions))).toEqual([
                "0",
                "0",
                "",
                "",
                "0",
                "null",
                "null",
                "null",
                "",
                "null",
            ]);
        }
        expect(resolveGlobalChatVar("flag", undefined, undefined, definitions)).toBe("null");
        expect(resolveGlobalChatVar("toggle_missing", { toggle_missing: "" }, {}, definitions)).toBe("null");
    });

    it("resolves chat before legacy before defaults while preserving cleared text and textarea", () => {
        const definitions = "flag=Flag\nmode=Mode=select=First,Second\ntext=Text=text\narea=Area=textarea";
        const keys = ["toggle_flag", "toggle_mode", "toggle_text", "toggle_area", "toggle_unknown", "plain"];
        const read = (chat: Record<string, unknown>, legacy: Record<string, unknown>) =>
            keys.map((key) => resolveGlobalChatVar(key, chat, legacy, definitions));
        const legacy = Object.fromEntries(keys.map((key) => [key, "legacy"]));
        expect(read(Object.fromEntries(keys.map((key) => [key, "chat"])), legacy)).toEqual([
            "chat",
            "chat",
            "chat",
            "chat",
            "chat",
            "chat",
        ]);
        expect(read(Object.fromEntries(keys.map((key) => [key, ""])), legacy)).toEqual([
            "legacy",
            "legacy",
            "",
            "",
            "legacy",
            "legacy",
        ]);
        expect(read(Object.fromEntries(keys.map((key) => [key, "null"])), legacy)).toEqual([
            "legacy",
            "legacy",
            "legacy",
            "legacy",
            "legacy",
            "legacy",
        ]);
        expect(read({}, Object.fromEntries(keys.map((key) => [key, ""])))).toEqual(["0", "0", "", "", "null", "null"]);
    });
});
