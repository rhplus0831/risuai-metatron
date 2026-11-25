import { expect, it } from "vitest";
import { prepareQuery } from "src/ts/util/koreanSearch";
import {
    catalogRows,
    choiceForAnswer,
    folderChoices,
    moduleCatalog,
    switchAllForChat,
    switchAllGlobally,
    type CatalogModule,
    type CatalogRow,
} from "./moduleCatalog";

function rowLabels(rows: CatalogRow<CatalogModule>[]) {
    return rows.map((row) =>
        row.type === "folder"
            ? { folder: row.folder.id, open: row.open }
            : { module: row.module.id, folder: row.folderId },
    );
}

it("lists folders and their members by name before root modules, assigning shared ids in stored folder order", () => {
    const catalog = moduleCatalog(
        [
            { id: "root-z", name: "Zulu root" },
            { id: "z-last", name: "zulu" },
            { id: "shared", name: "Shared" },
            { id: "a-first", name: "alpha" },
            { id: "a-last", name: "Beta" },
            { id: "root-a", name: "alpha root" },
            { id: "z-first", name: "Alpha" },
        ],
        [
            { id: "z", name: "Zulu", data: ["z-last", "shared", "z-first", "missing"] },
            { id: "a", name: "alpha", data: ["a-last", "shared", "a-first"] },
            { id: "empty", name: "Bravo", data: [] },
        ],
        null,
    );

    expect(rowLabels(catalogRows(catalog, () => false))).toEqual([
        { folder: "a", open: true },
        { module: "a-first", folder: "a" },
        { module: "a-last", folder: "a" },
        { folder: "empty", open: true },
        { folder: "z", open: true },
        { module: "z-first", folder: "z" },
        { module: "shared", folder: "z" },
        { module: "z-last", folder: "z" },
        { module: "root-a", folder: null },
        { module: "root-z", folder: null },
    ]);
});

it("searches module names only, omits folders without matches, and opens matching folders despite their fold state", () => {
    const modules = [
        { id: "z-other", name: "Unrelated" },
        { id: "z-match", name: "Match Zulu" },
        { id: "name-only", name: "Irrelevant" },
        { id: "a-match", name: "match Alpha" },
        { id: "a-other", name: "Other" },
        { id: "root-other", name: "Root" },
        { id: "root-match", name: "MATCH root" },
    ];
    const folders = [
        { id: "z", name: "Zulu", data: ["z-other", "z-match"] },
        { id: "name-only", name: "match", data: ["name-only"] },
        { id: "a", name: "alpha", data: ["a-match", "a-other"] },
        { id: "empty", name: "match empty", data: [] },
    ];
    const folded = () => true;
    expect(rowLabels(catalogRows(moduleCatalog(modules, folders, null), folded))).toEqual([
        { folder: "a", open: false },
        { folder: "name-only", open: false },
        { folder: "empty", open: false },
        { folder: "z", open: false },
        { module: "root-match", folder: null },
        { module: "root-other", folder: null },
    ]);

    const matching = moduleCatalog(modules, folders, prepareQuery("MATCH"));
    expect(rowLabels(catalogRows(matching, folded))).toEqual([
        { folder: "a", open: true },
        { module: "a-match", folder: "a" },
        { folder: "z", open: true },
        { module: "z-match", folder: "z" },
        { module: "root-match", folder: null },
    ]);
    // Searching narrows the display, while a folder's switch still acts on all its members.
    expect(matching.folders.map(({ folder, memberIds }) => ({ id: folder.id, memberIds }))).toEqual([
        { id: "a", memberIds: ["a-match", "a-other"] },
        { id: "z", memberIds: ["z-other", "z-match"] },
    ]);
});

it("keeps one safe move-dialog label per folder, maps duplicate labels by index, and ignores invalid answers", () => {
    const folders = [
        { id: "c", name: "C", data: [] },
        { id: "bar-first", name: "|", data: [] },
        { id: "joined", name: "A||B", data: [] },
        { id: "bar-second", name: "|", data: [] },
    ];
    const expected = [
        { id: "bar-first", label: "｜" },
        { id: "bar-second", label: "｜" },
        { id: "joined", label: "A｜｜B" },
        { id: "c", label: "C" },
        { id: null, label: "No folder" },
    ];
    const choices = folderChoices(folders, "Unnamed folder", "No folder");
    expect(choices).toEqual(expected);
    expect(
        choices
            .map(({ label }) => label)
            .join("||")
            .split("||"),
    ).toEqual(["｜", "｜", "A｜｜B", "C", "No folder"]);
    expect(["0", "1", "2", "3", "4"].map((answer) => choiceForAnswer(choices, answer))).toEqual(expected);
    expect(["", "5", "-1", "1.5", "word"].map((answer) => choiceForAnswer(choices, answer))).toEqual([
        null,
        null,
        null,
        null,
        null,
    ]);
    expect(folders.map(({ id, name }) => ({ id, name }))).toEqual([
        { id: "c", name: "C" },
        { id: "bar-first", name: "|" },
        { id: "joined", name: "A||B" },
        { id: "bar-second", name: "|" },
    ]);
});

it.each([
    { state: "all on", enabled: ["other", "alpha", "beta"], expected: ["other"] },
    { state: "some on", enabled: ["other", "alpha"], expected: ["other", "alpha", "beta"] },
    { state: "none on", enabled: ["other"], expected: ["other", "alpha", "beta"] },
])("switches a folder globally with $state, preserving unrelated ids", ({ enabled, expected }) => {
    const members = Object.freeze(["alpha", "beta"]);
    expect(switchAllGlobally(members, Object.freeze(enabled))).toEqual(expected);
});

it.each([
    { state: "all on", chat: ["other", "global", "alpha", "beta"], expected: ["other", "global"] },
    { state: "some on", chat: ["other", "alpha"], expected: ["other", "alpha", "beta"] },
    { state: "none on", chat: ["other"], expected: ["other", "alpha", "beta"] },
])("switches a folder for a chat with $state, leaving globally enabled members out", ({ chat, expected }) => {
    const members = Object.freeze(["global", "alpha", "beta"]);
    expect(switchAllForChat(members, Object.freeze(["global"]), Object.freeze(chat))).toEqual(expected);
});
