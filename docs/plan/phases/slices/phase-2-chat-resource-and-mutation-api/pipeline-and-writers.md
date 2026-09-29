# Slice: Pipeline And Writers

Status: done on 2026-09-29 (review round 3, the phase exit).

Phase: [Phase 2](../../phase-2-chat-resource-and-mutation-api.md), plan sections C, D, and the B1
mirror types.

## Scope

Allowed files: every chat writer and reader on a send, trigger, Lua, command, or plugin path
(`src/ts/process/**`, `src/ts/parser/**`, `src/ts/cbs.ts`, `src/ts/plugins/apiV3/v3.svelte.ts`,
`src/ts/characters.ts`, `src/ts/util.ts`, `src/ts/tokenizer.ts`), the chat UI (`src/lib/ChatScreens/*`,
`src/lib/SideBars/*`, `src/lib/Others/*` editors), `shared/database.ts` and `shared/readonly.ts`,
`src/ts/storage/{chatEdits.ts,localLoreDraft.svelte.ts}`, `src/lang/en.ts`, and the docs. Tests
belong to the review step.

Stopping condition: a writer that cannot be expressed by id without changing upstream semantics
(recorded instead).

## Decisions

- `character.chats` and `chatPage` are `DeepReadonly` in `shared/database.ts` itself (not a
  client-only view type): the strict server never assigns them, detached builders use literals.
- Send context: `chatTarget` is captured before any await and passed to everything the send calls
  (parser `chatRef`, scripts, triggers, Lua, lore, modules, persona, the request hook and trigger,
  listeners, recursive sends). A selection hold was tried and dropped: it could freeze the wrong chat
  and depended on every caller clearing the busy flag.
- Continue locks its message at the start of the send; streaming display writes use the
  generation's capability; strong-mode abort skips the deferred `editoutput`.
- Triggers keep upstream semantics: they edit a clone, CBS and lore read (and lore flags write) the
  live chat, now always the trigger's chat; display and request runs read it and never write.
- Plugin whole-object setters apply as diffs against the chat at call time (the plugin's copy wins
  where it differs); a generating character is not replaced or removed; duplicate ids are refused.
- Pagehide: one `keepalive` batch with whole texts under a 60 KiB body budget, pre-signed token; the
  request goes through the save loop's bookkeeping, so a page restored from the back-forward cache
  settles it like any acknowledgement.
- The lock is reactive and lasts until the final write is acknowledged: `Chat.svelte` disables a
  locked message's controls from `isMessageLocked` and re-checks every affected id at commit; reroll
  and chat deletion alert `chatGenerating`. Other refused writes reach the user through the global
  rejection alert.
- New characters' chats have ids at creation (the creators' literals; `normalizeNewCharacter` and
  `assignMissingChaId` for plugin-supplied characters).

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`; manual scenarios in headless Chrome
against a slow mock provider (sends in every display mode, abort, continue, reroll, commands, tab
kill, two tabs, group, chat operations, backup, Lua triggers and hooks, selection changes mid-send);
Docker smoke; Astra challenges 1-10, Fable's review and its follow-up (see the phase file).

## Residual risk

Busy-flag leaks in the PO import, DevTool autopilot, and preview on a throwing hook are upstream and
unchanged. Triggers and command lines are not atomic: effects before a refused write stay applied, as
upstream's did. Plugin character setters still accept malformed entries (upstream did too). While an
unload answer is outstanding after a back-forward-cache restore, `flushResources` can reject if the
answer is slower than its cycles. Character-level Lua and trigger helpers still read the selected character where upstream
did.
