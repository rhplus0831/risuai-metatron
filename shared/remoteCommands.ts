import type { LoreBudgetStop } from "./contextReport.ts";

/** Commands are relayed by HTTP and retained only in the server process; reads declare action support. */
export const REMOTE_COMMANDS_PATH = "/api/remote-commands";

/** Version 2 hosts preserve Continue and in-place reroll action fields. */
export const REMOTE_COMMAND_CONTRACT_VERSION = 2;

export const MAX_OPEN_COMMANDS_PER_TARGET = 16;
export const MAX_REMOTE_COMMAND_BODY_BYTES = 1024 * 1024;
export const REMOTE_COMMAND_PICKUP_MS = 30_000;
export const REMOTE_COMMAND_CLOSED_KEEP_MS = 10 * 60_000;
export const REMOTE_COMMAND_OPEN_DROP_MS = 40 * 60_000;

export type RemoteReloadMode = "plugins" | "page";

export type RemoteCommand =
    | {
          type: "send";
          chaId: string;
          chatId: string;
          input: string;
          /** Required when input is nonempty. */
          userMessageId?: string;
          requestId: string;
          continue?: true;
          continueMessageId?: string;
          rerollMessageId?: string;
          speakerChaId?: string;
          inputOriginal?: string;
          stopOverLoreBudget?: boolean;
      }
    | { type: "reload"; mode: RemoteReloadMode };

/** Older hosts would turn these actions into ordinary sends. */
export function remoteCommandNeedsActionSupport(command: RemoteCommand): boolean {
    return (
        command.type === "send" &&
        (command.continue === true ||
            command.continueMessageId !== undefined ||
            command.rerollMessageId !== undefined ||
            command.speakerChaId !== undefined)
    );
}

/** `applied` means the loader completed, not that every guest finished startup. */
export type PluginReloadOutcome = "applied" | "failed" | "pluginsOff";
/** `notReloaded` is a page reload that could not safely persist its recovery marker or navigate. */
export type RemoteReloadResult = { outcome: PluginReloadOutcome | "notReloaded" };

/** Only action fields identify a retry; the first accepted body's other fields stand. */
export function remoteCommandAction(command: RemoteCommand) {
    switch (command.type) {
        case "reload":
            return { type: command.type, mode: command.mode };
        case "send":
            return {
                type: command.type,
                chaId: command.chaId,
                chatId: command.chatId,
                input: command.input,
                userMessageId: command.userMessageId,
                ...(command.continue === true ? { continue: true } : {}),
                ...(command.continueMessageId !== undefined ? { continueMessageId: command.continueMessageId } : {}),
                ...(command.rerollMessageId !== undefined ? { rerollMessageId: command.rerollMessageId } : {}),
                ...(command.speakerChaId !== undefined ? { speakerChaId: command.speakerChaId } : {}),
            };
    }
}

export function sameRemoteAction(a: RemoteCommand, b: RemoteCommand): boolean {
    return JSON.stringify(remoteCommandAction(a)) === JSON.stringify(remoteCommandAction(b));
}

export const REMOTE_COMMAND_STATES = [
    "queued",
    "delivered",
    "running",
    "uncertain",
    "done",
    "refused",
    "expired",
    "cancelled",
] as const;
export type RemoteCommandState = (typeof REMOTE_COMMAND_STATES)[number];
export type RemoteCommandFrameState = RemoteCommandState | "forgotten";
export const REMOTE_COMMAND_REFUSAL_CODES = ["stopped", "pluginsOff", "chatMissing", "busy", "unsupported"] as const;
export type RemoteCommandRefusalCode = (typeof REMOTE_COMMAND_REFUSAL_CODES)[number];
export type RemoteCommandResult = Record<string, unknown>;

/** A send's caller-owned reports survive even when the send throws. */
export type SendReport = { kind: "error" | "notice"; text: string };

/** The host's send outcome, including reports returned to the sending device. */
export type RemoteSendResult = {
    ok: boolean;
    refusal?: "definite" | "ambiguous";
    settled: boolean;
    outcome: "started" | "replayed" | "followed" | "refused" | "unknown";
    requestUncertain: boolean;
    reconciled?: boolean;
    blockedChats: { chaId: string; chatId: string }[];
    loreStop?: { lore: LoreBudgetStop; message: string };
    reports: SendReport[];
    reportShownElsewhere?: true;
    /** Report texts were shortened to fit the relay's body limit. */
    truncated?: true;
};

export const REMOTE_COMMAND_ERRORS = {
    targetUnavailable: "targetUnavailable",
    unknownCommand: "unknownCommand",
    commandChanged: "commandChanged",
    targetFull: "targetFull",
    invalidTransition: "invalidTransition",
} as const;
export type RemoteCommandError = (typeof REMOTE_COMMAND_ERRORS)[keyof typeof REMOTE_COMMAND_ERRORS];

export type RemoteCommandPostBody = {
    clientId: string;
    target: string;
    commandId: string;
    command: RemoteCommand;
    uncertain?: boolean;
};
export type RemoteCommandStateBody = {
    clientId: string;
    attempt: number;
} & (
    | { state: "running" }
    | { state: "uncertain" | "done"; result?: RemoteCommandResult }
    | { state: "refused"; code: RemoteCommandRefusalCode }
);
export type RemoteCommandCancelBody = { clientId: string };

export type RemoteCommandStateAnswer = {
    state: RemoteCommandState;
    stopRequested: boolean;
    attempt: number;
    superseded?: true;
};
export type RemoteCommandStatusAnswer = {
    state: RemoteCommandState;
    attempted: boolean;
    stopRequested: boolean;
    attempt: number;
    code?: RemoteCommandRefusalCode;
    result?: RemoteCommandResult;
};
export type RemoteCommandPostAnswer = RemoteCommandStatusAnswer;
export type RemoteCommandCancelAnswer = RemoteCommandStateAnswer;
export type RemoteCommandReadAnswer = {
    command: RemoteCommand;
    state: RemoteCommandState;
    attempted: boolean;
    stopRequested: boolean;
    attempt: number;
};
