import type { Context, Hono, MiddlewareHandler } from "hono";
import { GENERATION_ID_PATTERN } from "../../../shared/jobs.ts";
import {
    MAX_REMOTE_COMMAND_BODY_BYTES,
    REMOTE_COMMAND_REFUSAL_CODES,
    REMOTE_COMMANDS_PATH,
} from "../../../shared/remoteCommands.ts";
import type { RemoteCommand, RemoteCommandPostBody, RemoteCommandStateBody } from "../../../shared/remoteCommands.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { isValidResourceId } from "../data/resourceStore.ts";
import { readJsonBody } from "../http/body.ts";
import type { RemoteCommands } from "../remoteCommands.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { limitedBody } from "./limitedBody.ts";

function commandId(value: unknown): value is string {
    return typeof value === "string" && GENERATION_ID_PATTERN.test(value);
}

function parsePost(value: unknown): RemoteCommandPostBody | null {
    if (
        !isPlainObject(value) ||
        !isValidResourceId(value.clientId) ||
        !isValidResourceId(value.target) ||
        !commandId(value.commandId)
    )
        return null;
    if (value.uncertain !== undefined && typeof value.uncertain !== "boolean") return null;
    const command = value.command;
    if (
        !isPlainObject(command) ||
        command.type !== "send" ||
        command.requestId !== value.commandId ||
        !isValidResourceId(command.chaId) ||
        !isValidResourceId(command.chatId) ||
        !isValidResourceId(command.userMessageId) ||
        typeof command.input !== "string" ||
        (command.inputOriginal !== undefined && typeof command.inputOriginal !== "string") ||
        (command.stopOverLoreBudget !== undefined && typeof command.stopOverLoreBudget !== "boolean")
    )
        return null;
    // Retain only the contract's fields, never an unvalidated extra payload.
    const parsed: RemoteCommand = {
        type: "send",
        requestId: value.commandId,
        chaId: command.chaId,
        chatId: command.chatId,
        userMessageId: command.userMessageId,
        input: command.input,
        ...(command.inputOriginal !== undefined ? { inputOriginal: command.inputOriginal } : {}),
        ...(command.stopOverLoreBudget !== undefined ? { stopOverLoreBudget: command.stopOverLoreBudget } : {}),
    };
    return {
        clientId: value.clientId,
        target: value.target,
        commandId: value.commandId,
        command: parsed,
        ...(value.uncertain !== undefined ? { uncertain: value.uncertain } : {}),
    };
}

function parseState(value: unknown): RemoteCommandStateBody | null {
    if (
        !isPlainObject(value) ||
        !isValidResourceId(value.clientId) ||
        typeof value.attempt !== "number" ||
        !Number.isSafeInteger(value.attempt) ||
        value.attempt <= 0
    )
        return null;
    if (value.result !== undefined && !isPlainObject(value.result)) return null;
    if (value.code !== undefined && !REMOTE_COMMAND_REFUSAL_CODES.some((code) => code === value.code)) return null;
    const base = { clientId: value.clientId, attempt: value.attempt };
    switch (value.state) {
        case "running":
            return { ...base, state: value.state };
        case "uncertain":
        case "done":
            return { ...base, state: value.state, ...(value.result !== undefined ? { result: value.result } : {}) };
        case "refused": {
            const code = REMOTE_COMMAND_REFUSAL_CODES.find((code) => code === value.code);
            return code ? { ...base, state: value.state, code } : null;
        }
        default:
            return null;
    }
}

/**
 * All five HTTP routes require JWT, the authenticated limiter, and the current resource epoch.
 * Every answer is no-store; every POST caps its body after authentication. Bodies travel only here,
 * and the registry never executes them. Non-participants see the same 404 as an unknown command.
 */
export function registerRemoteCommandRoutes(
    app: Hono<AppEnv>,
    options: {
        commands: RemoteCommands;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        epoch: () => string;
        bodyBytes?: number;
    },
) {
    const { commands, auth, limiter } = options;
    const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
        try {
            await next();
        } finally {
            c.header("Cache-Control", "no-store");
        }
    };
    const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
        const denied = await auth.checkAuth(c);
        if (denied) return denied;
        await next();
    };
    const limitBody = limitedBody(options.bodyBytes ?? MAX_REMOTE_COMMAND_BODY_BYTES);
    // Called after the last await: a body arriving across a restore must not enter the new epoch.
    function epochMismatch(c: Context<AppEnv>) {
        const epoch = options.epoch();
        return c.req.header(RESOURCE_EPOCH_HEADER) === epoch ? null : c.json({ error: "EpochMismatch", epoch }, 412);
    }

    app.post(REMOTE_COMMANDS_PATH, noStore, limiter, authenticated, limitBody, async (c) => {
        const read = await readJsonBody(c);
        if (!read.ok) return read.response;
        const mismatch = epochMismatch(c);
        if (mismatch) return mismatch;
        const body = parsePost(read.body);
        if (!body) return c.json({ error: "Invalid remote command" }, 400);
        const result = commands.post(body);
        return result.ok ? c.json(result.body) : c.json(result.body, result.status);
    });

    app.get(`${REMOTE_COMMANDS_PATH}/:id`, noStore, limiter, authenticated, (c) => {
        const mismatch = epochMismatch(c);
        if (mismatch) return mismatch;
        const id = c.req.param("id");
        const clientId = c.req.query("clientId");
        if (!commandId(id) || !isValidResourceId(clientId))
            return c.json({ error: "Invalid command or client id" }, 400);
        const result = commands.read(id, clientId);
        return result.ok ? c.json(result.body) : c.json(result.body, result.status);
    });

    app.post(`${REMOTE_COMMANDS_PATH}/:id/state`, noStore, limiter, authenticated, limitBody, async (c) => {
        const read = await readJsonBody(c);
        if (!read.ok) return read.response;
        const mismatch = epochMismatch(c);
        if (mismatch) return mismatch;
        const body = parseState(read.body);
        const id = c.req.param("id");
        if (!commandId(id) || !body) return c.json({ error: "Invalid command state" }, 400);
        const result = commands.report(id, body);
        return result.ok ? c.json(result.body) : c.json(result.body, result.status);
    });

    app.post(`${REMOTE_COMMANDS_PATH}/:id/cancel`, noStore, limiter, authenticated, limitBody, async (c) => {
        const read = await readJsonBody(c);
        if (!read.ok) return read.response;
        const mismatch = epochMismatch(c);
        if (mismatch) return mismatch;
        const id = c.req.param("id");
        if (!commandId(id) || !isPlainObject(read.body) || !isValidResourceId(read.body.clientId))
            return c.json({ error: "Invalid command or client id" }, 400);
        const result = commands.cancel(id, read.body.clientId);
        return result.ok ? c.json(result.body) : c.json(result.body, result.status);
    });

    app.get(`${REMOTE_COMMANDS_PATH}/:id/status`, noStore, limiter, authenticated, (c) => {
        const mismatch = epochMismatch(c);
        if (mismatch) return mismatch;
        const id = c.req.param("id");
        const clientId = c.req.query("clientId");
        if (!commandId(id) || !isValidResourceId(clientId))
            return c.json({ error: "Invalid command or client id" }, 400);
        const result = commands.status(id, clientId);
        return result.ok ? c.json(result.body) : c.json(result.body, result.status);
    });
}
