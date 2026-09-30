import { getDatabase, saveImage } from "./storage/database.svelte";
import { selectSingleFile, sleep } from "./util";
import { alertError, alertNormal, alertStore } from "./alert";
import { AppendableBuffer, downloadFile, readImage } from "./globalApi.svelte";
import { language } from "src/lang";
import { reencodeImage } from "./process/files/inlays";
import { PngChunk } from "./pngChunk";
import { newPersonaId } from "../../shared/presets.ts";
import { selectedPersona } from "./storage/forwarding.svelte";
import { selectPersona } from "./storage/selection.svelte";
import { DBState } from "./stores.svelte";
import { addPersona } from "./storage/collectionStore.svelte";

/**
 * Sets the selected persona's icon from a picked PNG. The persona is captured before the file dialog
 * (the selection can change meanwhile) and keeps its id, so chats bound to it stay bound; the
 * icon is dropped if the persona was deleted meanwhile.
 */
export async function selectUserImg() {
    const personaId = selectedPersona(DBState.db)?.id;
    const selected = await selectSingleFile(["png"]);
    if (!selected || !personaId) {
        return;
    }
    const icon = await saveImage(selected.data);
    const persona = DBState.db.personas.find((entry) => entry.id === personaId);
    if (persona) {
        persona.icon = icon;
    }
}

/**
 * Selects persona `id` for this client. The persona fields are forwarded to the selected persona,
 * so nothing is copied.
 */
export function changeUserPersona(id: string) {
    if (DBState.db.personas.some((persona) => persona.id === id)) {
        selectPersona(id);
    }
}

interface PersonaCard {
    name: string;
    personaPrompt: string;
    note?: string;
}

export async function exportUserPersona() {
    let db = getDatabase({ snapshot: true });
    if (!db.username || !db.personaPrompt) {
        alertError("username or persona prompt is empty");
        return;
    }

    let img: Uint8Array;
    if (!db.userIcon) {
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "rgb(100, 116, 139)";
        ctx.fillRect(0, 0, 256, 256);
        const dataUrl = canvas.toDataURL("image/png");
        const base64 = dataUrl.split(",")[1];
        img = new Uint8Array(Buffer.from(base64, "base64"));
    } else {
        img = await readImage(db.userIcon);
    }

    let card: PersonaCard = safeStructuredClone({
        name: db.username,
        personaPrompt: db.personaPrompt,
        note: db.userNote,
    });

    alertStore.set({
        type: "wait",
        msg: "Loading... (Writing Exif)",
    });

    await sleep(10);

    img = (await PngChunk.write(await reencodeImage(img), {
        persona: Buffer.from(JSON.stringify(card)).toString("base64"),
    })) as Uint8Array;

    alertStore.set({
        type: "wait",
        msg: "Loading... (Writing)",
    });

    await sleep(10);
    await downloadFile(`${db.username.replace(/[<>:"/\\|?*\.\,]/g, "")}_export.png`, img);

    alertNormal(language.successExport);
}

export async function importUserPersona() {
    try {
        const v = await selectSingleFile(["png"]);
        if (!v) {
            return;
        }
        const readGenerator = PngChunk.readGenerator(v.data);
        let decoded: string | undefined;

        for await (const chunk of readGenerator) {
            if (chunk && !(chunk instanceof AppendableBuffer) && chunk.key === "persona") {
                decoded = chunk.value;
                break;
            }
        }

        if (!decoded) {
            alertError(language.errors.noData);
            return;
        }
        const data: PersonaCard = JSON.parse(Buffer.from(decoded, "base64").toString("utf-8"));
        if (data.name && data.personaPrompt) {
            // The image first: the collection can be replaced meanwhile, so the add reads the live list.
            const icon = await saveImage(await reencodeImage(v.data));
            addPersona({
                name: data.name,
                icon,
                personaPrompt: data.personaPrompt,
                note: typeof data.note === "string" ? data.note : "",
                id: newPersonaId(),
            });
            alertNormal(language.successImport);
        } else {
            alertError(language.errors.noData);
        }
    } catch (error) {
        alertError(error);
        return;
    }
}
