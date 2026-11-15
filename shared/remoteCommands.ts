/** Commands are relayed by HTTP and retained only in the server process. */
export const REMOTE_COMMANDS_PATH = "/api/remote-commands";

export const MAX_OPEN_COMMANDS_PER_TARGET = 16;
export const MAX_REMOTE_COMMAND_BODY_BYTES = 1024 * 1024;
export const REMOTE_COMMAND_PICKUP_MS = 30_000;
export const REMOTE_COMMAND_CLOSED_KEEP_MS = 10 * 60_000;
export const REMOTE_COMMAND_OPEN_DROP_MS = 40 * 60_000;

export type RemoteCommand = {
    type: "send";
    chaId: string;
    chatId: string;
    input: string;
    userMessageId: string;
    requestId: string;
    inputOriginal?: string;
    stopOverLoreBudget?: boolean;
};

/** Only action fields identify a retry; the first accepted body's other fields stand. */
export function remoteCommandAction(command: RemoteCommand) {
    switch (command.type) {
        case "send":
            return {
                type: command.type,
                chaId: command.chaId,
                chatId: command.chatId,
                input: command.input,
                userMessageId: command.userMessageId,
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
export const REMOTE_COMMAND_REFUSAL_CODES = ["stopped", "pluginsOff", "chatMissing", "busy"] as const;
export type RemoteCommandRefusalCode = (typeof REMOTE_COMMAND_REFUSAL_CODES)[number];
export type RemoteCommandResult = Record<string, unknown>;

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
