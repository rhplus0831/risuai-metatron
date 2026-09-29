# Slice: Client Chat Module

Status: done on 2026-09-29 (review round 2).

Phase: [Phase 2](../../phase-2-chat-resource-and-mutation-api.md), plan section B.

## Scope

Allowed files: `src/ts/storage/{chatStore.svelte.ts,resourceSync.svelte.ts,resourceClient.ts,database.svelte.ts}`,
`src/ts/bootstrap.ts`, `src/ts/globalApi.svelte.ts` (`changeChatTo`). Tests belong to the review step.
This slice was a branch checkpoint, not a deployable client: chat writers outside the module were
routed in round 3.

Stopping condition: a round-3 caller the module API cannot serve by id.

## Decisions

- One module owns `character.chats` and `chatPage`; every write updates the mirror, bumps a per-chat
  version, and queues ops (coalesced) that the save loop takes per cycle. In-flight work is
  immutable until acknowledged, requeued, or recovered; a sent-but-unacknowledged create is resent as
  sent and recognized when the server already holds it.
- `applyChatResult` applies a whole-chat result three ways (baseline, result, current) as by-id ops,
  `replaceChat` only for a reorder of surviving messages with nothing changed meanwhile.
- Selection is per tab (selected chat id per character, `chatPage` derived, a `localStorage`
  preference read at boot).
- Generation lock in the module (`beginGeneration`, 3 s checkpoints, `endGeneration`); the lock
  lasts until the final write is acknowledged or discarded; `ignored` rejects the generation.
- Conflict recovery per chat: by-id work the server can still apply is kept, the rest discarded with
  the notice; a chat with a running generation reloads after it ends. A 400 naming one chat group
  quarantines that chat.
- Binding/alias inventory (exit artifact; fixed in round 3): `SideChatList.svelte` and
  `ChatList.svelte` chat-name bindings, `CharConfig.svelte` note and SupaMemory bindings,
  `LoreBookList.svelte` → `LoreBookData.svelte` local lore, the HypaV3 modal and its children,
  `AlertComp.svelte` HypaV2 chunk text, `DevTool.svelte` chat variables; `Chat.svelte` binds only a
  local editing string.

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`; manual scenarios in headless Chrome (create with a
character, module ops, reload and idle reload, checkpoints, tab close, two tabs); Astra challenges 1-6
and Fable's review (see the phase file).

## Residual risk

A reorder adopted from a create acknowledgement can include another tab's reorder the mirror has not
seen (last writer wins on order until the next conflict).
