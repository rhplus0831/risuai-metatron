# Issues found during the structure audit

These findings were checked against `744d17cad` on 2026-11-18. Each entry names the affected behavior, the evidence and
a focused follow-up. The [project inbox](../backlog/found-issues.md) links here for triage.

## Chat and recovery

### A refused multisend can clear chat history

`runMultisend` clears history in clear mode and appends the next user message before `prepareServerJob` checks the chat
binding. An isolated run with a refused send left only the newly appended message. A retained slash draft can reach this
path via Enter, and a binding can become invalid between parts. The PO translator and DevTool autopilot also append
before this check. Check the binding before each part's first mutation and cover refusal with an existing transcript.
[Slash command](../../src/ts/process/command.ts#L40) ·
[Composer dispatch](../../src/lib/ChatScreens/DefaultChatScreen.svelte#L703) ·
[Job admission](../../src/ts/process/serverCommands.ts#L1162)

### Journal recovery can replay an edit after a newer chat revision

Source review found that `recoverJournal` reads the boot summary revision before awaiting the full chat. For pending
by-ID edits, it classifies the returned body using the earlier revision. A pending append whose ID is still absent can
replay after another writer changes the chat, even though the recovery classifier would file a draft with the newer
revision. Pair the full body with its installed revision and exercise an intervening write during the boot read.
[Recovery decision](../../src/ts/storage/journalRecovery.ts#L1335) ·
[Classifier](../../src/ts/storage/journalRecovery.ts#L567) ·
[Server acceptance](../../server/src/data/chatStore.ts#L2237)

### Two tabs can replace each other's OOC answer

A retry checks that an exchange is unanswered before requesting the preview. While the tab waits for the answer, another
tab can answer the same question. The final write checks that the exchange still exists, then replaces its answer. An
isolated run inserted an answer during that wait and observed it being overwritten. Cover competing completions for a
single exchange and make the chosen write rule hold across tabs.
[OOC admission and answer write](../../src/ts/ooc/oocSession.svelte.ts#L183)

### PO translation can download an incomplete file

`sendPofile` finishes an entry only on an exactly empty line. In isolated runs, CRLF input lost an entry, and the final
entry of a file without a trailing newline was never translated. An ordinary comment past line index 100 can also break
the loop and reach the download with only a prefix. Cover line endings, end-of-file and comments in a long catalog.
[PO reader and download](../../src/ts/process/files/multisend.ts#L32)

## Memory

### HypaV2 can mark messages summarized by a blank answer

A whitespace-only response from either the `subModel` or `distilbart` branch returned success in the existing
cold-overflow fixture. HypaV2 marked 11 messages as covered and produced zero retrievable chunks. The fixed-completion
branch already rejects trimmed-empty output. Apply the same check before advancing coverage in the two affected
branches. This narrows the earlier inbox question about other algorithms.
[HypaV2 summarization](../../server/src/prompt/memory/hypav2.ts#L19) ·
[Chunk and coverage update](../../server/src/prompt/memory/hypav2.ts#L448) ·
[Fixture](../../server/src/tests/fixtures/memory/scenarios.ts)

### Record now can skip confirmation for a second model call

With a marked greeting-only event and one confirmed ordinary turn, the cost query reported one call. The real planner
produced two windows, one to repair the greeting and one for the turn. The panel asks for confirmation at two estimated
calls. Count greeting-only work in the record estimate and verify the confirmation with the same chat.
[Cost query](../../server/src/prompt/memory/structured/rebuild.ts#L758) ·
[Window planner](../../server/src/prompt/memory/structured/window.ts#L403) ·
[Panel confirmation](../../src/lib/Others/StructuredMemory/memoryRecordPress.ts#L44)

### The toggle test header points to an obsolete memory control

The header of `Toggles.test.ts` says its checkbox writes the character's memory switch. The tests now assert the switch
is absent there. The per-chat control lives in `ChatMemoryPanel.svelte`. Update the test header so a search for the old
field leads to the current contract. [Stale header](../../src/lib/SideBars/Toggles.test.ts#L6) ·
[Current control](../../src/lib/SideBars/ChatMemoryPanel.svelte)

## Plugins, settings and media

### A TypeScript compilation error can replace a working plugin

Source review found that `importPlugin` reports a transpilation error and continues with the original TypeScript as the
guest script. A supported plugin that passes the remaining import checks can therefore overwrite its installed version.
Return on compilation failure and verify that replacing a working plugin leaves its saved script intact.
[Compiler error path](../../src/ts/plugins/plugins.svelte.ts#L355) ·
[Install write](../../src/ts/plugins/plugins.svelte.ts#L441)

### Tab-side MCP tool discovery can keep fetching pages

The tab's `MCPClient.getToolList` appends successive pages while a remote server supplies a cursor. Source review found
no check for a repeated cursor or cumulative page, tool or byte limits. A malfunctioning service can keep discovery
pending and growing until cancelled. The server client already enforces those bounds.
[Tab discovery](../../src/ts/process/mcp/mcplib.ts#L1047) · [Server discovery](../../server/src/mcp/client.ts#L874)

### A concurrent edit can redirect a settings drag

The interception-rule and prompt-template editors remember source and target indexes through a drag. Their drop handlers
apply those indexes to the current list. Source review found that a reorder arriving from another tab can change which
item is moved. Test a second-tab update between drag start and drop. Resolve interception rules by ID and cancel a
prompt-template drop if the captured preset or list has changed.
[Interception editor](../../src/lib/Setting/Pages/RequestInterceptionSettings.svelte#L140) ·
[Prompt editor](../../src/lib/Setting/Pages/PromptSettings.svelte#L101)

### Hugging Face TTS can silently discard a service error

An isolated run of `sayTTS` with a JSON HTTP 503 error and no retry estimate made one request and returned without
playback, retry or alert. With the same body and HTTP 502, the error alert appeared. Surface the provider error when the
503 response supplies no usable estimate. [TTS response handling](../../src/ts/process/tts.ts#L439)

## Build checks

### The type-check cache can replay a pass for a failing ignored file

The initial cache key includes ignored files under source roots. The final unchanged-tree check omits them. In an
isolated Git project, the cache keyed an ignored file containing a type error. The file was corrected before the
compiler read it, so the run passed. After restoring the error, the cache replayed success while a forced compiler run
failed. Compare the program's complete input key again before saving the result.
[Input hashing](../../util/typeCheckCache.mjs#L62) · [End-of-run check](../../util/changedChecks.mjs#L259) ·
[Cache write](../../util/typeCheckCache.mjs#L154)
