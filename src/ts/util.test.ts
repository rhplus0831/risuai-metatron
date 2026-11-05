import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./globalApi.svelte", async () => (await import("./tests/globalApiMock")).createGlobalApiMock());
vi.mock("./stores.svelte", async () => (await import("./tests/storesMock")).createStoresMock());
vi.mock("./alert", async () => (await import("./tests/alertMock")).createAlertMock());

let util: typeof import("./util");
let records: typeof import("./storage/records.svelte");

beforeAll(async () => {
    await import("./storage/database.svelte");
    util = await import("./util");
    records = await import("./storage/records.svelte");
});

beforeEach(() => {
    records.initializeRecords({ ui: { allowAllExtentionFiles: false } });
});

afterEach(() => {
    document.body.replaceChildren();
    records.resetRecords();
});

function pickerInput() {
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    return input!;
}

describe("replaceAsync", () => {
    it("replaces every match regardless of the global regexp's lastIndex", async () => {
        const regexp = /a/g;
        for (const lastIndex of [0, 1, 2, 10]) {
            regexp.lastIndex = lastIndex;
            await expect(util.replaceAsync("aa", regexp, async () => "X")).resolves.toBe("XX");
        }
    });
});

describe("selectFileByDom", () => {
    it("resolves an empty array and removes the input when the picker is cancelled", async () => {
        const result = util.selectFileByDom(["txt"]);
        const input = pickerInput();
        input.dispatchEvent(new Event("cancel"));

        await expect(result).resolves.toEqual([]);
        expect(document.body.contains(input)).toBe(false);
    });

    it("forwards the changed files and removes the input for empty and populated selections", async () => {
        const file = new File(["picked"], "picked.txt", { type: "text/plain" });
        for (const files of [[], [file]]) {
            const result = util.selectFileByDom(["txt"]);
            const input = pickerInput();
            Object.defineProperty(input, "files", { value: files });
            input.dispatchEvent(new Event("change"));

            await expect(result).resolves.toEqual(files);
            expect(document.body.contains(input)).toBe(false);
        }
    });
});

describe("selectSingleFile", () => {
    it("resolves null on cancel or an empty eligible selection", async () => {
        const ineligible = new File(["ignored"], "ignored.png", { type: "image/png" });
        for (const [event, files] of [
            ["cancel", []],
            ["change", []],
            ["change", [ineligible]],
        ] as const) {
            const result = util.selectSingleFile(["txt"]);
            const input = pickerInput();
            Object.defineProperty(input, "files", { value: files });
            input.dispatchEvent(new Event(event));

            await expect(result).resolves.toBeNull();
            input.remove();
        }
    });
});
