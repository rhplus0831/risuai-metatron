import { settings } from "./storage/settingsViews.svelte";
import { get, writable } from "svelte/store";
import { saveImage, type character, type Chat, defaultSdDataFunc, getDatabase } from "./storage/database.svelte";
import { alertAddCharacter, alertConfirm, alertError, alertNormal, alertSelect, alertStore, alertWait } from "./alert";
import { language } from "../lang";
import {
    checkNullish,
    findCharacterbyId,
    findCharacterIndexbyId,
    getUserName,
    selectMultipleFile,
    selectSingleFile,
} from "./util";
import { v4 as uuidv4, v4 } from "uuid";
import { getImageType } from "./media";
import { DBState, OpenRealmStore, selectedCharID } from "./stores.svelte";
import {
    addCharacter as addCharacterRecord,
    findCharacter,
    removeCharacter,
    updateCharacter,
} from "./storage/characterStore.svelte";
import { AppendableBuffer, changeChatTo, checkCharOrder, downloadFile, getFileSrc } from "./globalApi.svelte";
import { parseMarkdownSafe } from "./parser/parser.svelte";
import { translateHTML } from "./translator/translator";
import { doingChat } from "./process/index.svelte";
import { createChat, ensureChat, isCharacterGenerating, syncChatPage } from "./storage/chatStore.svelte";
import { importCharacter } from "./characterCards";
import { PngChunk } from "./pngChunk";

export function createNewCharacter() {
    return findCharacterIndexbyId(addCharacterRecord(createBlankChar()));
}

export function createNewGroup() {
    const chaId = addCharacterRecord({
        type: "group",
        name: "",
        firstMessage: "",
        chats: [
            {
                id: uuidv4(),
                message: [],
                note: "",
                name: "Chat 1",
                localLore: [],
            },
        ],
        chatFolders: [],
        chatPage: 0,
        viewScreen: "none",
        globalLore: [],
        characters: [],
        autoMode: false,
        useCharacterLore: true,
        emotionImages: [],
        customscript: [],
        chaId: uuidv4(),
        firstMsgIndex: -1,
        characterTalks: [],
        characterActive: [],
    });
    return findCharacterIndexbyId(chaId);
}

export async function getCharImage(loc: string, type: "plain" | "css" | "contain" | "lgcss") {
    // Return placeholder when hideAllImages is enabled
    if (settings.ui.hideAllImages) {
        if (type === "plain") {
            return "/none.webp";
        }
        return ""; // For CSS types, return empty to show default ? icon
    }

    if (!loc || loc === "") {
        if (type === "css") {
            return "";
        }
        return null;
    }
    const filesrc = await getFileSrc(loc);
    if (type === "plain") {
        return filesrc;
    } else if (type === "css") {
        return `background: url("${filesrc}");background-size: cover;`;
    } else if (type === "lgcss") {
        return `background: url("${filesrc}");background-size: cover;height: 10.66rem;`;
    } else {
        return `background: url("${filesrc}");background-size: contain;background-repeat: no-repeat;background-position: center;`;
    }
}

export async function selectCharImg(charIndex: number) {
    const target = DBState.db.characters[charIndex];
    if (!target) {
        return;
    }
    const chaId = target.chaId;
    const isCharacter = target.type === "character";
    const selected = await selectSingleFile(["png", "webp", "gif", "jpg", "jpeg"]);
    if (!selected) {
        return;
    }
    const img = selected.data;
    const pngExif: Record<string, string> = {};

    const type = getImageType(img);

    try {
        if (type === "PNG" && isCharacter) {
            const gen = PngChunk.readGenerator(img);
            const allowedChunk = [
                "parameters",
                "Comment",
                "Title",
                "Description",
                "Author",
                "Software",
                "Source",
                "Disclaimer",
                "Warning",
                "Copyright",
            ];
            for await (const chunk of gen) {
                if (chunk instanceof AppendableBuffer) {
                    continue;
                }
                if (!chunk) {
                    continue;
                }
                if (chunk.value.length > 20_000) {
                    continue;
                }
                if (allowedChunk.includes(chunk.key)) {
                    console.log(chunk.key, chunk.value);
                    pngExif[chunk.key] = chunk.value;
                }
            }
        }
    } catch (error) {
        console.error(error);
    }

    const imgp = await saveImage(img);
    charIndex = findCharacterIndexbyId(chaId);
    if (charIndex === -1) {
        return;
    }
    const current = DBState.db.characters[charIndex];
    if (current.type === "character" && Object.keys(pngExif).length > 0) {
        current.extentions ??= {};
        current.extentions.pngExif = { ...current.extentions.pngExif, ...pngExif };
    }
    dumpCharImage(charIndex);
    current.image = imgp;
}

export function dumpCharImage(charIndex: number) {
    const char = DBState.db.characters[charIndex] as character;
    if (!char.image || char.image === "") {
        return;
    }
    char.ccAssets ??= [];
    char.ccAssets.push({
        type: "icon",
        name: "iconx",
        uri: char.image,
        ext: "png",
    });
    char.image = "";
}

export function changeCharImage(charIndex: number, changeIndex: number) {
    const char = DBState.db.characters[charIndex] as character;
    const image = char.ccAssets[changeIndex].uri;
    char.ccAssets.splice(changeIndex, 1);
    dumpCharImage(charIndex);
    char.image = image;
}

export const addingEmotion = writable(false);

export async function addCharEmotion(charId: number) {
    addingEmotion.set(true);
    const selected = await selectMultipleFile(["png", "webp", "gif"]);
    if (!selected) {
        addingEmotion.set(false);
        return;
    }
    let db = DBState.db;
    for (const f of selected) {
        const img = f.data;
        const imgp = await saveImage(img);
        const name = f.name.replace(".png", "").replace(".webp", "");
        let dbChar = db.characters[charId];
        if (dbChar.type !== "group") {
            dbChar.emotionImages.push([name, imgp]);
        }
    }
    addingEmotion.set(false);
}

export function rmCharEmotion(charId: number, emotionId: number) {
    let dbChar = DBState.db.characters[charId];
    if (dbChar.type !== "group") {
        dbChar.emotionImages.splice(emotionId, 1);
    }
}

export async function exportChat(page: number) {
    try {
        const mode = await alertSelect([
            "Export as JSON",
            "Export as TXT",
            "Export as HTML File",
            "Export as HTML Embed",
        ]);
        const doTranslate =
            mode === "2" || mode === "3"
                ? (await alertSelect([language.translateContent, language.doNotTranslate])) === "0"
                : false;
        const anonymous =
            mode === "2" || mode === "3"
                ? (await alertSelect([language.includePersonaName, language.hidePersonaName])) === "1"
                : false;
        const selectedID = get(selectedCharID);
        const db = DBState.db;
        const chat = db.characters[selectedID].chats[page];
        const char = db.characters[selectedID];
        const date = new Date().toJSON();
        const htmlChatParse = async (v: string) => {
            v = parseMarkdownSafe(v);

            if (doTranslate) {
                v = await translateHTML(v, false, "", -1);
            }

            if (anonymous) {
                //case insensitive match, replace all
                const excapedName = char.name.replace(/[-\/\\^$*+\?\.()|[\]{}]/g, "\\$&");

                v = v.replace(new RegExp(`${excapedName}`, "gi"), "×××");
            }

            return v;
        };

        if (mode === "0") {
            let folders = [];
            if (chat.folderId) {
                folders = db.characters[selectedID].chatFolders?.filter((f) => f.id === chat.folderId);
            }
            const stringl = Buffer.from(
                JSON.stringify({
                    type: "risuChat",
                    ver: 2,
                    data: chat,
                    folders: folders,
                }),
                "utf-8",
            );

            await downloadFile(`${char.name}_${date}_chat`.replace(/[<>:"/\\|?*\.\,]/g, "") + ".json", stringl);
        } else if (mode === "2") {
            let chatContentHTML = "";

            let i = 0;
            for (const v of chat.message) {
                alertWait(`Translating... ${i++}/${chat.message.length}`);
                const name = v.saying
                    ? findCharacterbyId(v.saying).name
                    : v.role === "char"
                      ? char.name
                      : anonymous
                        ? "×××"
                        : getUserName();
                chatContentHTML += `<div class="chat">
                    <h2>${name}</h2>
                    <div>${await htmlChatParse(v.data)}</div>
                </div>`;
            }

            const doc = `
                <!DOCTYPE html>
                <html>
                    <head>
                        <title>${char.name} Chat</title>
                        <style>
                            body{
                                font-family: Arial, sans-serif;
                                display: flex;
                                justify-content: center;
                            }
                            .container{
                                max-width: 800px;
                                padding: 1rem;
                                border-radius: 10px;
                                display: flex;
                                flex-direction: column;
                                gap: 1rem;
                            }
                            .chat{
                                background: #f0f0f0;
                                padding: 1rem;
                                border-radius: 10px;
                                display: flex;
                                flex-direction: column;
                            }
                            .idat{
                                display: none;
                            }
                            h2{
                                margin: 0;
                            }
                            .chat div{
                                margin-top: 0.5rem;
                                break-word: break-all;
                            }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="chat">
                                <h2>${char.name}</h2>
                                <div>${await htmlChatParse(
                                    chat.fmIndex === -1
                                        ? char.firstMessage
                                        : char.alternateGreetings?.[chat.fmIndex ?? 0],
                                )}</div>
                            </div>
                            ${chatContentHTML}
                        </div>
                        <div class="idat">${JSON.stringify(chat).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
                    </body>
            `;

            await downloadFile(
                `${char.name}_${date}_chat`.replace(/[<>:"/\\|?*\.\,]/g, "") + ".html",
                Buffer.from(doc, "utf-8"),
            );
        } else if (mode === "3") {
            //create a html table
            let chatContentHTML = "";

            let i = 0;
            for (const v of chat.message) {
                alertWait(`Translating... ${i++}/${chat.message.length}`);
                const name = v.saying
                    ? findCharacterbyId(v.saying).name
                    : v.role === "char"
                      ? char.name
                      : anonymous
                        ? "×××"
                        : getUserName();
                chatContentHTML += `<tr>
                    <td>${name}</td>
                    <td>${await htmlChatParse(v.data)}</td>
                </tr>`;
            }

            const template = `
                <table>
                    <tr>
                        <th>Character</th>
                        <th>Message</th>
                    </tr>
                    <tr>
                        <td>${char.name}</td>
                        <td>${await htmlChatParse(char.firstMessage)}</td>
                    </tr>
                    ${chatContentHTML}
                </table>
                <p>Chat from Risuai</p>
            `;

            //copy to clipboard

            const item = new ClipboardItem({
                "text/html": new Blob([template], { type: "text/html" }),
                "text/plain": new Blob([template], { type: "text/plain" }),
            });
            await navigator.clipboard.write([item]);

            alertNormal(language.clipboardSuccess);
            return;
        } else {
            let stringl = chat.message
                .map((v) => {
                    if (v.saying) {
                        return `--${findCharacterbyId(v.saying).name}\n${v.data}`;
                    } else {
                        return `--${v.role === "char" ? char.name : getUserName()}\n${v.data}`;
                    }
                })
                .join("\n\n");

            if (char.type !== "group") {
                stringl = `--${char.name}\n${char.firstMessage}\n\n` + stringl;
            }

            await downloadFile(
                `${char.name}_${date}_chat`.replace(/[<>:"/\\|?*\.\,]/g, "") + ".txt",
                Buffer.from(stringl, "utf-8"),
            );
        }
        alertNormal(language.successExport);
    } catch (error) {
        alertError(error);
    }
}

export async function importChat() {
    // The character is the one selected when the import starts, captured by id before the file dialog.
    const chaId = DBState.db.characters[get(selectedCharID)]?.chaId;
    if (!chaId) {
        return;
    }
    const dat = await selectSingleFile(["json", "jsonl", "txt", "html"]);
    if (!dat) {
        return;
    }
    try {
        const target = findCharacter(chaId);
        if (!target) {
            alertError(language.errors.importTargetGone);
            return;
        }
        /** Adds imported chats at the top of the list, in their order (new chat and message ids where needed). */
        const addChats = (chats: Chat[]) => {
            chats.forEach((chat, index) => {
                createChat(chaId, chat, { index });
            });
        };

        if (dat.name.endsWith("jsonl")) {
            const lines = Buffer.from(dat.data).toString("utf-8").split("\n");
            let newChat: Chat = {
                message: [],
                note: "",
                name: "Imported Chat",
                localLore: [],
                fmIndex: -1,
                id: v4(),
            };

            let isFirst = true;
            for (const line of lines) {
                const presedLine = JSON.parse(line);
                if ((presedLine.name && presedLine.is_user, presedLine.mes)) {
                    if (!isFirst) {
                        newChat.message.push({
                            role: presedLine.is_user ? "user" : "char",
                            data: formatTavernChat(presedLine.mes, target.name),
                        });
                    }
                }

                isFirst = false;
            }

            if (newChat.message.length === 0) {
                alertError(language.errors.noData);
                return;
            }

            if ((target.chatFolders ?? []).filter((folder) => folder.id === newChat.folderId).length === 0) {
                newChat.folderId = null;
            }

            addChats([newChat]);
            // Only while the importing character is still the one on screen.
            if (DBState.db.characters[get(selectedCharID)]?.chaId === chaId) {
                changeChatTo(0);
            }
            alertNormal(language.successImport);
        } else if (dat.name.endsWith("json")) {
            const json = JSON.parse(Buffer.from(dat.data).toString("utf-8"));
            if ((json.type === "risuAllChats" || json.type === "risuChat") && json.ver === 2) {
                const folders = json.folders || [];
                const chats = Array.isArray(json.data) ? json.data : [json.data];
                let folderIdMap = {};
                folders.forEach((folder) => {
                    if (target.chatFolders?.some((f) => f.id === folder.id)) {
                        const newId = uuidv4();
                        folderIdMap[folder.id] = newId;
                        folder.id = newId;
                    } else {
                        folderIdMap[folder.id] = folder.id;
                    }
                });
                updateCharacter(chaId, { chatFolders: [...(target.chatFolders ?? []), ...folders] });
                chats.forEach((chat) => {
                    if (chat.folderId && folderIdMap[chat.folderId]) {
                        chat.folderId = folderIdMap[chat.folderId];
                    }
                    chat.id = v4();
                });
                addChats(chats);
                alertNormal(language.successImport);
                return;
            }
            if (json.type === "risuAllChats" && json.ver === 1) {
                const chats = json.data;
                if (Array.isArray(chats) && chats.length > 0) {
                    addChats(
                        chats.map((v) => {
                            if (!v.id) {
                                v.id = uuidv4();
                            }
                            if (!v.localLore) {
                                v.localLore = [];
                            }
                            v.fmIndex ??= -1;
                            return v;
                        }),
                    );
                    alertNormal(language.successImport);
                    return;
                } else {
                    alertError(language.errors.noData);
                    return;
                }
            }
            if (json.type === "risuChat" && json.ver === 1) {
                const das: Chat = json.data;
                if (!(
                    checkNullish(das.message) ||
                    checkNullish(das.note) ||
                    checkNullish(das.name) ||
                    checkNullish(das.localLore)
                )) {
                    das.fmIndex ??= -1;
                    das.id = v4();
                    addChats([das]);
                    alertNormal(language.successImport);
                    return;
                } else {
                    alertError(language.errors.noData);
                    return;
                }
            } else {
                alertError(language.errors.noData);
                return;
            }
        } else if (dat.name.endsWith("html")) {
            const doc = new DOMParser().parseFromString(Buffer.from(dat.data).toString("utf-8"), "text/html");
            const chat = doc.querySelector(".idat").textContent;
            const json = JSON.parse(chat);
            if (json.message && json.note && json.name && json.localLore) {
                addChats([json]);
                alertNormal(language.successImport);
            } else {
                alertError(language.errors.noData);
            }
        }
    } catch (error) {
        alertError(error);
    }
}

export async function exportAllChats() {
    try {
        const selectedID = get(selectedCharID);
        const db = getDatabase();
        const char = db.characters[selectedID];
        const date = new Date().toISOString().replace(/[:.]/g, "-");
        const allChats = char.chats;
        const allFolders = char.chatFolders;
        const stringl = Buffer.from(
            JSON.stringify({
                type: "risuAllChats",
                ver: 2,
                data: allChats,
                folders: allFolders,
            }),
            "utf-8",
        );
        await downloadFile(`${char.name}_all_chats_${date}`.replace(/[<>:"/\\|?*.,]/g, "") + ".json", stringl);
        alertNormal(language.successExport);
    } catch (error) {
        alertError(error);
    }
}

function formatTavernChat(chat: string, charName: string) {
    return chat
        .replace(/<([Uu]ser)>|\{\{([Uu]ser)\}\}/g, getUserName())
        .replace(/((\{\{)|<)([Cc]har)(=.+)?((\}\})|>)/g, charName);
}

export function createBlankChar(): character {
    return {
        name: "",
        firstMessage: "",
        desc: "",
        notes: "",
        chats: [
            {
                id: uuidv4(),
                message: [],
                note: "",
                name: "Chat 1",
                localLore: [],
            },
        ],
        chatFolders: [],
        chatPage: 0,
        emotionImages: [],
        bias: [],
        viewScreen: "none",
        globalLore: [],
        chaId: uuidv4(),
        type: "character",
        sdData: defaultSdDataFunc(),
        utilityBot: false,
        customscript: [],
        exampleMessage: "",
        creatorNotes: "",
        systemPrompt: "",
        postHistoryInstructions: "",
        alternateGreetings: [],
        tags: [],
        creator: "",
        characterVersion: "",
        personality: "",
        scenario: "",
        firstMsgIndex: -1,
        replaceGlobalNote: "",
        triggerscript: [
            {
                comment: "",
                type: "manual",
                conditions: [],
                effect: [
                    {
                        type: "v2Header",
                        code: "",
                        indent: 0,
                    },
                ],
            },
            {
                comment: "New Event",
                type: "manual",
                conditions: [],
                effect: [],
            },
        ],
        additionalText: "",
    };
}

export async function makeGroupImage() {
    try {
        alertStore.set({
            type: "wait",
            msg: `Loading..`,
        });
        const db = getDatabase();
        const charID = get(selectedCharID);
        const group = db.characters[charID];
        if (group.type !== "group") {
            return;
        }
        const chaId = group.chaId;

        const imageUrls = await Promise.all(
            group.characters.map((v) => {
                return getCharImage(findCharacterbyId(v).image, "plain");
            }),
        );

        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext("2d");

        // Load the images
        const images = [];
        let loadedImages = 0;

        await Promise.all(
            imageUrls.map(
                (url) =>
                    new Promise<void>((resolve) => {
                        const img = new Image();
                        img.crossOrigin = "anonymous";
                        img.onload = () => {
                            images.push(img);
                            resolve();
                        };
                        img.src = url;
                    }),
            ),
        );

        // Calculate dimensions and draw the grid
        const numImages = images.length;
        const numCols = Math.ceil(Math.sqrt(images.length));
        const numRows = Math.ceil(images.length / numCols);
        const cellWidth = canvas.width / numCols;
        const cellHeight = canvas.height / numRows;

        for (let row = 0; row < numRows; row++) {
            for (let col = 0; col < numCols; col++) {
                const index = row * numCols + col;
                if (index >= numImages) break;
                ctx.drawImage(images[index], col * cellWidth, row * cellHeight, cellWidth, cellHeight);
            }
        }

        // Return the image URI

        const uri = canvas.toDataURL();
        canvas.remove();
        const image = await saveImage(dataURLtoBuffer(uri));
        const index = findCharacterIndexbyId(chaId);
        if (index !== -1) {
            DBState.db.characters[index].image = image;
        }
        alertStore.set({
            type: "none",
            msg: "",
        });
    } catch (error) {
        alertError(error);
    }
}

function dataURLtoBuffer(string: string) {
    const regex = /^data:.+\/(.+);base64,(.*)$/;

    const matches = string.match(regex);
    const ext = matches[1];
    const data = matches[2];
    return Buffer.from(data, "base64");
}

export function restoreChar(chaId: string) {
    if (!updateCharacter(chaId, { trashTime: undefined })) {
        return;
    }
    checkCharOrder();
}

export async function removeChar(
    identifier: string | number,
    name: string,
    type: "normal" | "permanent" | "permanentForce" = "normal",
) {
    const db = getDatabase();
    // The character is resolved by id after the confirmations (the list may change meanwhile).
    const chaId = typeof identifier === "string" ? identifier : db.characters[identifier]?.chaId;
    if (type !== "permanentForce") {
        const conf = await alertConfirm(language.removeConfirm + name);
        if (!conf) {
            return;
        }
        const conf2 = await alertConfirm(language.removeConfirm2 + name);
        if (!conf2) {
            return;
        }
    }
    const index = chaId === undefined ? -1 : findCharacterIndexbyId(chaId);
    if (index === -1) {
        return;
    }
    if (type !== "normal" && isCharacterGenerating(chaId)) {
        // Deleting it would delete the chat a reply is being written to.
        alertError(language.characterGenerating);
        return;
    }
    if (type === "normal") {
        updateCharacter(chaId, { trashTime: Date.now() });
        checkCharOrder();
    } else {
        removeCharacter(chaId);
    }
    selectedCharID.set(-1);
}

export async function addCharacter(
    arg: {
        reseter?: () => any;
    } = {},
) {
    const reseter = arg.reseter ?? (() => {});
    const r = await alertAddCharacter();
    if (r === "importFromRealm") {
        selectedCharID.set(-1);
        OpenRealmStore.set(true);
        return;
    }
    reseter();
    switch (r) {
        case "createfromScratch":
            createNewCharacter();
            break;
        case "createGroup":
            createNewGroup();
            break;
        case "importCharacter":
            await importCharacter();
            break;
        default:
            return;
    }
    let db = getDatabase();
    if (db.characters[db.characters.length - 1]) {
        changeChar(db.characters.length - 1);
    }
}

export async function changeChar(
    index: number,
    arg: {
        reseter?: () => any;
    } = {},
) {
    const reseter = arg.reseter ?? (() => {});
    if (get(doingChat)) {
        return;
    }
    reseter();
    // A selection only makes sure the character has a chat and shows its chat (owner decision 2: it
    // no longer stamps `lastInteraction`; a send does). The defaults come from creation and the server.
    const chaId = DBState.db.characters[index]?.chaId;
    if (chaId !== undefined) {
        ensureChat(chaId);
        syncChatPage(chaId);
    }
    selectedCharID.set(index);
}
