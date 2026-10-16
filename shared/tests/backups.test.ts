import { describe, expect, it } from "vitest";
import { selectPartialBackupAssets } from "../backups.ts";

// The partial-backup asset selector (`shared/backups.ts`): the categories the server selects from its
// archived snapshot and the client labels in its report, over plain resource records.

describe("selectPartialBackupAssets", () => {
    it("selects profile images, persona icons, the background, folder images, and preset images, deduplicated", () => {
        const selected = selectPartialBackupAssets([
            {
                kind: "characters",
                data: { name: "Alice", image: "assets/alice.png", emotionImages: [["happy", "assets/happy.png"]] },
            },
            { kind: "characters", data: { name: "Group", type: "group", image: "assets/alice.png" } },
            { kind: "characters", data: { name: "No image" } },
            {
                kind: "personas",
                data: [
                    { name: "Me", icon: "assets/me.png" },
                    { name: "Blank", icon: "" },
                ],
            },
            { kind: "ui", data: { customBackground: "assets/bg.png", userIcon: "assets/elsewhere.png" } },
            {
                kind: "characterOrder",
                data: [
                    "alice",
                    { type: "folder", name: "F", img: "assets/folder.png", imgFile: "assets/folder-file.png" },
                ],
            },
            { kind: "presets", data: [{ name: "P", image: "assets/preset.png" }, { name: "Plain" }] },
            { kind: "modules", data: [{ name: "M", image: "assets/module.png" }] },
        ]);
        expect(selected).toEqual([
            { key: "assets/alice.png", owner: "Group", role: "profile" },
            { key: "assets/me.png", owner: "Me", role: "persona" },
            { key: "assets/bg.png", owner: "", role: "background" },
            { key: "assets/folder.png", owner: "F", role: "folder" },
            { key: "assets/folder-file.png", owner: "F", role: "folderFile" },
            { key: "assets/preset.png", owner: "P", role: "preset" },
        ]);
    });

    it("ignores keys outside the assets namespace, non-string values, and malformed records", () => {
        expect(
            selectPartialBackupAssets([
                { kind: "characters", data: { name: "Data", image: "data:image/png;base64,AAAA" } },
                { kind: "characters", data: { name: "Number", image: 7 } },
                { kind: "characters", data: "not a record" },
                { kind: "personas", data: { icon: "assets/not-a-list.png" } },
                { kind: "characterOrder", data: [null, 3, "id"] },
                { kind: "ui", data: null },
            ]),
        ).toEqual([]);
    });
});
