// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkOwnership, formatOwner, ownerOf, parseOwnership } from "./docsOwner.mjs";

describe("checkOwnership", () => {
    it("rejects a rule that matches no tracked path or only paths owned by an earlier rule", () => {
        const rules = [
            { match: "src/chat/**", guide: "chat" },
            { match: "src/**", guide: "client" },
        ];
        const text = JSON.stringify({ rules });
        const tracked = ["src/chat/main.ts", "src/main.ts"];
        const guides = new Set(["chat", "client"]);
        expect(checkOwnership(text, tracked, guides)).toEqual([]);

        expect(checkOwnership(text, ["src/main.ts"], guides)).toEqual([
            expect.objectContaining({ message: expect.stringContaining("src/chat/**") }),
        ]);
        expect(checkOwnership(JSON.stringify({ rules: [...rules].reverse() }), tracked, guides)).toEqual([
            expect.objectContaining({ message: expect.stringContaining("src/chat/**") }),
        ]);
    });

    it("rejects a tracked path under an owned root when no rule covers it", () => {
        const text = JSON.stringify({ rules: [{ match: "src/chat/**", guide: "chat" }] });
        const guides = new Set(["chat"]);
        expect(checkOwnership(text, ["src/chat/main.ts"], guides)).toEqual([]);

        expect(checkOwnership(text, ["src/chat/main.ts", "src/uncovered.ts"], guides)).toEqual([
            expect.objectContaining({ message: expect.stringContaining("src/uncovered.ts") }),
        ]);
    });

    it("rejects a rule naming a guide that does not exist", () => {
        const text = JSON.stringify({ rules: [{ match: "src/**", guide: "client" }] });
        const tracked = ["src/main.ts"];
        expect(checkOwnership(text, tracked, new Set(["client"]))).toEqual([]);

        expect(checkOwnership(text, tracked, new Set())).toEqual([
            expect.objectContaining({ message: expect.stringContaining("client") }),
        ]);
    });
});

describe("ownership lookup", () => {
    it("assigns the asset lifecycle client and its tests to assets", () => {
        const { rules } = parseOwnership(
            readFileSync(new URL("../docs/structure/ownership.json", import.meta.url), "utf8"),
        );
        expect(
            ["src/ts/storage/assetLifecycleClient.ts", "src/ts/storage/tests/assetLifecycleClient.test.ts"].map(
                (file) => ownerOf(rules, file)?.guide,
            ),
        ).toEqual(["assets", "assets"]);
    });

    it("uses the first matching glob for planned paths and dotfiles", () => {
        const { rules } = parseOwnership(
            JSON.stringify({
                rules: [
                    { match: "src/{chat,settings}/?*.ts", guide: "features" },
                    { match: "src/**", guide: "client" },
                    { match: "server/**", guide: "self-host-server" },
                ],
            }),
        );

        expect(ownerOf(rules, "src/chat/planned.ts")).toMatchObject({ guide: "features" });
        expect(formatOwner(rules, "src/settings/not-created-yet.ts")).toBe("src/settings/not-created-yet.ts features");
        expect(formatOwner(rules, "src/settings/.draft.ts")).toBe("src/settings/.draft.ts features");
        expect(formatOwner(rules, "src/chat/nested/planned.ts")).toBe("src/chat/nested/planned.ts client");
        expect(formatOwner(rules, "server/.env")).toBe("server/.env self-host-server");
        expect(ownerOf(rules, "docs/unowned.md")).toBeNull();
        expect(formatOwner(rules, "docs/unowned.md")).toBe("docs/unowned.md (no owner)");
    });

    it("formats a shared file with its other guides and their parts", () => {
        const { rules } = parseOwnership(
            JSON.stringify({
                rules: [
                    { match: "shared/session.ts", guide: "persistence", shared: true, part: "records" },
                    { match: "shared/session.ts", guide: "chat", shared: true, part: "messages" },
                    { match: "shared/session.ts", guide: "server", shared: true, part: "transport" },
                ],
            }),
        );

        expect(formatOwner(rules, "shared/session.ts")).toBe(
            "shared/session.ts persistence; also chat (messages), server (transport)",
        );
    });
});
