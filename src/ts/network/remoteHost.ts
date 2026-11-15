import { readonly, writable } from "svelte/store";
import type { RemoteCommandFrameState } from "../../../shared/remoteCommands.ts";
import { preference } from "./handoff";

/** Device-local host preference, including changes made by another tab in this browser. */
export const hostMode = preference<boolean>("risu-remote-host", false);

export type HostCommandEntry = {
    commandId: string;
    type: string;
    state: RemoteCommandFrameState;
    code?: string;
    at: number;
};

const commands = writable<readonly HostCommandEntry[]>([]);
export const hostCommandLog = readonly(commands);

/** Keep the ten newest command statuses, replacing a command's previous entry. */
export function noteHostCommand(entry: HostCommandEntry): void {
    commands.update((current) =>
        [{ ...entry }, ...current.filter((held) => held.commandId !== entry.commandId)]
            .sort((a, b) => b.at - a.at)
            .slice(0, 10),
    );
}
