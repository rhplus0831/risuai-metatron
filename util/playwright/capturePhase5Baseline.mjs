// Captures the Phase 5 baseline fixtures (docs/plan/phases/slices/phase-5-server-side-processing/
// implementation-plan.md, "Order and stops": the baseline capture after Stop A) from the browser
// path as it is before slice 3 changes it, into server/src/tests/fixtures/baseline/:
//
// - scenario.json: the seed (settings, personas, presets, characters, chats, messages) the capture
//   applied, so a server test can rebuild the same state.
// - prompts.json: the DevTool preview prompts (`sendChat(-1, { preview: true })` -> `previewFormated`)
//   of the fixture characters: plain, group, presetChain, jinja (plus the instruct renders and the
//   `previewPrompt` body), lore (every insertion position).
// - markdown.json: `ParseMarkdown` HTML (and the `editprocess` text) of fixture messages with
//   deterministic CBS, regex scripts, and a Lua `editDisplay` hook, with and without plugin hooks.
// - token-counts.json: `encode` routing per model configuration (fixed strings) and the token
//   counts of every prompt fixture per tokenizer family.
// - lore-regex.json: `loadLoreBookV3Prompt` on regex-keyed lore (the lore regex defect).
// - igp.json: a send with `igpPrompt` through a mock plugin provider (the `igp` defect).
// - provenance.json: commit, Chrome, capture time (the only file that changes between two
//   identical captures).
//
// Nondeterminism is controlled in the page: `Math.random` is a seeded PRNG re-seeded before every
// capture unit; `Date` is frozen with Playwright's clock (timers keep running); the context has a
// fixed viewport, timezone, and locale; every non-localhost request is answered 500 (no network);
// ids (characters, chats, messages, personas, presets) are assigned explicitly; the tokenizer cache is
// off. The procedure is described in the folder's README.
//
// Usage: node util/playwright/capturePhase5Baseline.mjs [outDir]
import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import * as prettier from "prettier";
import { chromePath, openApp, repoRoot, startStack } from "./stack.mjs";

const outDir = path.resolve(process.argv[2] ?? path.join(repoRoot, "server/src/tests/fixtures/baseline"));

// ---------------------------------------------------------------------------------------------
// The scenario (written to scenario.json as is).
// ---------------------------------------------------------------------------------------------

const FIXED_TIME = "2026-10-01T12:00:00.000Z";
const T0 = Date.parse(FIXED_TIME);
const SEED = 20261001;
const ENVIRONMENT = {
    fixedTime: FIXED_TIME,
    timezoneId: "UTC",
    locale: "en-US",
    viewport: { width: 1280, height: 720 },
    randomSeed: SEED,
    randomAlgorithm: "mulberry32 over Math.random, re-seeded with randomSeed before every capture unit",
};

const m = (chatId, role, data, minute, extra = {}) => ({
    chatId,
    role,
    data,
    time: T0 - (10 - minute) * 60_000,
    ...extra,
});
const lore = (comment, key, content, extra = {}) => ({
    key,
    secondkey: "",
    insertorder: 100,
    comment,
    content,
    mode: "normal",
    alwaysActive: false,
    selective: false,
    ...extra,
});
const chat = (id, name, message, extra = {}) => ({ id, name, message, note: "", localLore: [], fmIndex: -1, ...extra });

const BASE_SETTINGS = {
    username: "User",
    language: "en",
    selectedPersona: 0,
    aiModel: "reverse_proxy",
    subModel: "reverse_proxy",
    customTokenizer: "tik",
    customProxyRequestModel: "baseline-model",
    customAPIFormat: 0,
    forceReplaceUrl: "http://localhost:1/never-called",
    maxContext: 4000,
    maxResponse: 300,
    temperature: 80,
    mainPrompt: "You are {{char}}. The user is {{user}}. Stay in character.",
    jailbreakToggle: true,
    jailbreak: "Jailbreak text for {{char}}.",
    globalNote: "Global note for {{char}}.",
    promptPreprocess: true,
    additionalPrompt: "The assistant must act as {{char}}. user is {{user}}.",
    descriptionPrefix: "description of {{char}}: ",
    personaPrompt: "Default persona prompt for {{user}}.",
    formatingOrder: [
        "main",
        "description",
        "personaPrompt",
        "chats",
        "lastChat",
        "jailbreak",
        "lorebook",
        "globalNote",
        "authorNote",
    ],
    loreBookDepth: 5,
    loreBookToken: 8000,
    useTokenizerCaching: false,
    chainOfThought: false,
    promptSettings: {
        assistantPrefill: "",
        postEndInnerFormat: "",
        sendChatAsSystem: false,
        sendName: false,
        utilOverride: false,
        customChainOfThought: false,
        maxThoughtTagDepth: -1,
    },
    groupOtherBotRole: "user",
    groupTemplate: "",
    useStreaming: false,
    removeIncompleteResponse: false,
    autoContinueChat: false,
    autoContinueMinTokens: 0,
    ttsAutoSpeech: false,
    dynamicAssets: false,
    presetChain: "",
    igpPrompt: "",
    bias: [],
    presetRegex: [],
    instructChatTemplate: "chatml",
    JinjaTemplate: "",
};

const PERSONAS = [
    { name: "User", personaPrompt: "", icon: "", note: "", largePortrait: false, id: "persona-user" },
    {
        name: "Mina",
        personaPrompt: "Mina is a traveling archivist who asks precise questions.",
        icon: "",
        note: "",
        largePortrait: false,
        id: "persona-mina",
    },
];

/** Extra presets (normalized with `normalizePreset`); the default preset keeps index 0 and is named "Default". */
const PRESETS = [
    { name: "Alpha", mainPrompt: "Alpha main prompt for {{char}}." },
    { name: "Beta", mainPrompt: "Beta main prompt for {{char}}." },
];

const CHARACTERS = [
    {
        type: "character",
        chaId: "char-aria",
        name: "Aria",
        desc: "Aria is a {{char}} who guides {{user}} through the archive.\nShe speaks in short sentences.",
        personality: "curious, precise",
        scenario: "A rainy evening in the archive.",
        firstMessage: "*The lamp flickers.* Welcome, {{user}}. I am {{char}}.",
        alternateGreetings: ["Alternate greeting for {{user}}."],
        exampleMessage:
            "<START>\n{{user}}: Where are we?\n{{char}}: In the archive, {{user}}.\n<START>\n<user>: Hello\n<bot>: Hi.",
        systemPrompt: "{{original}}\n[Card system prompt for {{char}}]",
        replaceGlobalNote: "[Card note] {{original}}",
        depth_prompt: { depth: 2, prompt: "[Depth prompt at 2 for {{char}}]" },
        notes: "",
        globalLore: [],
        customscript: [],
        triggerscript: [],
        emotionImages: [],
        bias: [],
        viewScreen: "none",
        utilityBot: false,
        chatPage: 0,
        chatFolders: [],
        chats: [
            chat(
                "chat-aria-1",
                "Chat 1",
                [
                    m("m-a1", "user", "Hello {{char}}, I am {{user}}.", 1),
                    m("m-a2", "char", "Hello {{user}}. *smiles*", 2),
                    m("m-a3", "user", "Tell me about the archive.", 3),
                    m("m-a4", "char", "It holds every story ever told.", 4),
                    m("m-a5", "user", "Which one is yours?", 5),
                ],
                { note: "Author note: keep it short, {{user}}.", bindedPersona: "persona-mina" },
            ),
        ],
    },
    {
        type: "character",
        chaId: "char-lore",
        name: "Loremaster",
        desc: "Loremaster keeps the lore of {{user}}'s world.",
        personality: "",
        scenario: "",
        firstMessage: "Ask me about the dragon, the castle, or the river.",
        alternateGreetings: [],
        exampleMessage: "",
        systemPrompt: "",
        replaceGlobalNote: "",
        notes: "",
        globalLore: [
            lore("normal", "castle", "The castle stands on the hill."),
            lore("before", "castle", "@@position before_desc\nBefore the description."),
            lore("after", "castle", "@@position after_desc\nAfter the description."),
            lore("personality", "castle", "@@position personality\nPersonality position."),
            lore("scenario", "castle", "@@position scenario\nScenario position."),
            lore("end-system", "castle", "@@end\nAt the end as system."),
            lore("end-assistant", "castle", "@@depth 0\n@@role assistant\nAt the end as assistant."),
            lore("depth2-user", "castle", "@@depth 2\n@@role user\nDepth two as user."),
            lore("reverse1", "castle", "@@reverse_depth 1\nReverse depth one."),
            lore("pt-custom", "castle", "@@position pt_custom\nCustom position text."),
            lore("inject-main", "castle", "@@inject_at main\nInjected into main."),
            lore(
                "inject-desc-prepend",
                "castle",
                "@@inject_at description\n@@inject_prepend\nPrepended to the description card.",
            ),
            lore("inject-lore", "castle", "@@inject_lore normal\nAppended to the normal entry."),
            lore("always", "", "Always active entry.", { alwaysActive: true, insertorder: 50 }),
            lore("regex-i", "/dragon/i", "Regex entry with the i flag.", { useRegex: true }),
            lore("regex-empty", "/dragon/", "Regex entry with empty flags.", { useRegex: true }),
            lore("recursive", "hill", "Recursive: activated by the normal entry."),
            lore("selective", "river", "Selective river and boat.", { secondkey: "boat", selective: true }),
            lore("notmatched", "ocean", "Should not appear."),
            lore("priority", "castle", "@@priority 5\nLow priority entry.", { insertorder: 200 }),
            lore("fullword", "cast", "@@match_full_word\nFull word cast must not match castle."),
            lore("user-role", "castle", "@@role user\nNormal position as user."),
        ],
        customscript: [],
        triggerscript: [],
        emotionImages: [],
        bias: [],
        viewScreen: "none",
        utilityBot: false,
        chatPage: 0,
        chatFolders: [],
        chats: [
            chat(
                "chat-lore-1",
                "Chat 1",
                [
                    m("m-l1", "user", "Tell me about the castle and the dragon.", 1),
                    m("m-l2", "char", "The castle? Certainly.", 2),
                    m("m-l3", "user", "And the river with a boat.", 3),
                    m("m-l4", "char", "The river flows past.", 4),
                    m("m-l5", "user", "Go on.", 5),
                ],
                { localLore: [lore("chat-local", "castle", "Chat-local lore.")] },
            ),
        ],
    },
    {
        type: "character",
        chaId: "char-jinja",
        name: "Jin",
        desc: "Jin answers {{user}} tersely.",
        personality: "",
        scenario: "",
        firstMessage: "Jin here.",
        alternateGreetings: [],
        exampleMessage: "",
        systemPrompt: "",
        replaceGlobalNote: "",
        notes: "",
        globalLore: [],
        customscript: [],
        triggerscript: [],
        emotionImages: [],
        bias: [],
        viewScreen: "none",
        utilityBot: false,
        chatPage: 0,
        chatFolders: [],
        chats: [
            chat("chat-jinja-1", "Chat 1", [
                m("m-j1", "user", "Hi {{char}}.", 1),
                m("m-j2", "char", "Hi {{user}}.", 2),
                m("m-j3", "user", "Render me.", 3),
            ]),
        ],
    },
    {
        type: "character",
        chaId: "char-bram",
        name: "Bram",
        desc: "Bram is the loud one.",
        personality: "loud",
        scenario: "",
        firstMessage: "Bram's greeting.",
        alternateGreetings: [],
        exampleMessage: "",
        systemPrompt: "",
        replaceGlobalNote: "",
        notes: "",
        globalLore: [lore("bram-lore", "council", "Bram's own lore (member lore).")],
        customscript: [],
        triggerscript: [],
        emotionImages: [],
        bias: [],
        viewScreen: "none",
        utilityBot: false,
        chatPage: 0,
        chatFolders: [],
        chats: [chat("chat-bram-1", "Chat 1", [])],
    },
    {
        type: "character",
        chaId: "char-cora",
        name: "Cora",
        desc: "Cora is the quiet one.",
        personality: "quiet",
        scenario: "",
        firstMessage: "Cora's greeting.",
        alternateGreetings: [],
        exampleMessage: "",
        systemPrompt: "",
        replaceGlobalNote: "",
        notes: "",
        globalLore: [],
        customscript: [],
        triggerscript: [],
        emotionImages: [],
        bias: [],
        viewScreen: "none",
        utilityBot: false,
        chatPage: 0,
        chatFolders: [],
        chats: [chat("chat-cora-1", "Chat 1", [])],
    },
    {
        type: "group",
        chaId: "group-council",
        name: "Council",
        firstMessage: "",
        characters: ["char-bram", "char-cora"],
        characterTalks: [1, 1],
        characterActive: [true, true],
        orderByOrder: true,
        autoMode: false,
        useCharacterLore: true,
        firstMsgIndex: -1,
        globalLore: [lore("group-lore", "", "Group lore entry.", { alwaysActive: true })],
        emotionImages: [],
        customscript: [],
        viewScreen: "none",
        chatPage: 0,
        chatFolders: [],
        chats: [
            chat("chat-council-1", "Chat 1", [
                m("m-g1", "user", "Hello both, I am {{user}}.", 1),
                m("m-g2", "char", "Bram here, {{user}}.", 2, { saying: "char-bram" }),
                m("m-g3", "char", "Cora here.", 3, { saying: "char-cora" }),
                m("m-g4", "user", "Who speaks next about the council?", 4),
            ]),
        ],
    },
    {
        type: "character",
        chaId: "char-mark",
        name: "Mark",
        desc: "Mark renders markdown for {{user}}.",
        personality: "",
        scenario: "",
        firstMessage: "First message with *{{char}}* for {{user}}. ORDER",
        alternateGreetings: [],
        exampleMessage: "",
        systemPrompt: "",
        replaceGlobalNote: "",
        notes: "",
        globalLore: [],
        customscript: [
            { comment: "em", in: "\\*(.+?)\\*", out: "<em>$1</em>", type: "editdisplay", flag: "g", ableFlag: true },
            {
                comment: "order",
                in: "ORDER",
                out: "ordered-{{char}}",
                type: "editdisplay",
                flag: "g<order 5>",
                ableFlag: true,
            },
            {
                comment: "cbs-in",
                in: "{{char}}-tag",
                out: "[tag]",
                type: "editdisplay",
                flag: "g<cbs>",
                ableFlag: true,
            },
            {
                comment: "move",
                in: "^STATUS:.*$",
                out: "@@move_bottom $&",
                type: "editdisplay",
                flag: "m",
                ableFlag: true,
            },
            { comment: "process", in: "secret", out: "[redacted]", type: "editprocess", flag: "gi", ableFlag: true },
            { comment: "noflag", in: "plain", out: "PLAIN", type: "editdisplay" },
        ],
        triggerscript: [
            {
                comment: "lua-edit",
                type: "manual",
                conditions: [],
                effect: [
                    {
                        type: "triggerlua",
                        code: "listenEdit('editDisplay', function(id, data, meta) return data .. ' [lua:' .. tostring(meta.index) .. ']' end)",
                    },
                ],
            },
        ],
        emotionImages: [],
        bias: [],
        viewScreen: "none",
        utilityBot: false,
        chatPage: 0,
        chatFolders: [],
        chats: [
            chat(
                "chat-mark-1",
                "Chat 1",
                [
                    m("m-m1", "user", "Hello *{{char}}*, I am {{user}}. ORDER {{char}}-tag plain", 1),
                    m(
                        "m-m2",
                        "char",
                        "Mood is {{getvar::mood}} and hp {{calc::{{getvar::hp}}*2}}. {{#if {{equal::{{getvar::mood}}::calm}}}}calm-branch{{/if}}\nSTATUS: fine\nA secret line.",
                        2,
                    ),
                    m(
                        "m-m3",
                        "user",
                        "Random {{random}} pick {{random::alpha::beta::gamma}} dice {{dice::2d6}} int {{randint::1::100}}.",
                        3,
                    ),
                    m(
                        "m-m4",
                        "char",
                        "Date {{date}} time {{time}} unix {{unixtime}} screen {{screenwidth}}x{{screenheight}} lang {{metadata::browserlanguage}} ui {{metadata::language}}.",
                        4,
                    ),
                    m(
                        "m-m5",
                        "char",
                        "Markdown: **bold** _it_ `code`\n\n- a\n- b\n\n```js\nconst x = 1;\n```\n\n<Thoughts>hidden thought</Thoughts> visible <tool_call>id1lookup</tool_call>",
                        5,
                    ),
                    m(
                        "m-m6",
                        "char",
                        '<style>.x-risu-a{color:red}</style><div class="x-risu-a" onclick="alert(1)">styled <script>bad()</script></div> <img src=x onerror=alert(1)> plain',
                        6,
                    ),
                    m(
                        "m-m7",
                        "user",
                        "{{#if 1}}literal-if{{/if}} {{char}} and {{user}}; unknown {{nosuchfunction::x}} stays literal.",
                        7,
                    ),
                ],
                // Chat variables as `setChatVarOf` persists them (`scriptstate["$" + key]`).
                { scriptstate: { $mood: "calm", $hp: "7" } },
            ),
        ],
    },
    {
        type: "character",
        chaId: "char-regex",
        name: "Regex",
        desc: "",
        personality: "",
        scenario: "",
        firstMessage: "Regex lore host.",
        alternateGreetings: [],
        exampleMessage: "",
        systemPrompt: "",
        replaceGlobalNote: "",
        notes: "",
        globalLore: [],
        customscript: [],
        triggerscript: [],
        emotionImages: [],
        bias: [],
        viewScreen: "none",
        utilityBot: false,
        chatPage: 0,
        chatFolders: [],
        loreSettings: { scanDepth: 5, tokenBudget: 8000, recursiveScanning: false, fullWordMatching: false },
        chats: [
            chat("chat-rx-single-plain", "single-plain", [m("m-r1", "user", "A dragon appears.", 1)]),
            chat("chat-rx-single-slash", "single-slash", [m("m-r2", "user", "Take the /dragon path.", 1)]),
            chat("chat-rx-two-second", "two-second", [
                m("m-r3", "user", "Hello there.", 1),
                m("m-r4", "char", "Take the /dragon path.", 2),
            ]),
            chat("chat-rx-two-first", "two-first", [
                m("m-r5", "user", "Take the /dragon path.", 1),
                m("m-r6", "char", "Hello there.", 2),
            ]),
        ],
    },
    {
        type: "character",
        chaId: "char-igp",
        name: "Igor",
        desc: "Igor replies through the mock provider.",
        personality: "",
        scenario: "",
        firstMessage: "Igor's greeting.",
        alternateGreetings: [],
        exampleMessage: "",
        systemPrompt: "",
        replaceGlobalNote: "",
        notes: "",
        globalLore: [],
        customscript: [],
        triggerscript: [],
        emotionImages: [],
        bias: [],
        viewScreen: "none",
        utilityBot: false,
        chatPage: 0,
        chatFolders: [],
        chats: [chat("chat-igp-1", "Chat 1", [m("m-i1", "char", "Igor's first reply.", 1)])],
    },
];

const LORE_PROMPT_TEMPLATE = [
    { type: "plain", type2: "main", role: "system", text: "Main for {{char}}. {{position::custom}}" },
    { type: "description", innerFormat: "<desc>{{slot}}</desc>" },
    { type: "persona", innerFormat: "<persona>{{slot}}</persona>" },
    { type: "lorebook" },
    { type: "authornote", innerFormat: "<note>{{slot}}</note>", defaultText: "No note." },
    { type: "chat", rangeStart: 0, rangeEnd: "end" },
    { type: "jailbreak", role: "system", text: "Jailbreak card for {{char}}." },
    { type: "chatML", text: "<|im_start|>system<|im_sep|>ChatML card for {{char}}<|im_end|>" },
    { type: "cot", role: "system", text: "COT card." },
    { type: "plain", type2: "globalNote", role: "system", text: "Global note card." },
    { type: "cache", role: "user", depth: 1 },
    { type: "postEverything" },
];

const JINJA_TEMPLATE =
    "{% for message in messages %}<{{ message.role }}>{{ message.content }}</{{ message.role }}>\n{% endfor %}{% if add_generation_prompt %}<assistant>{% endif %}[{{ risu_char }}/{{ risu_user }}]";

/** The prompt fixtures, in capture order (the lore fixture, which sets a prompt template, is last). */
const PROMPTS = [
    { name: "plain", chaId: "char-aria", chatId: "chat-aria-1", settings: {} },
    { name: "group", chaId: "group-council", chatId: "chat-council-1", settings: {} },
    {
        name: "presetChain",
        chaId: "char-aria",
        chatId: "chat-aria-1",
        settings: { presetChain: "Alpha, Beta, Missing" },
        restorePreset: true,
    },
    {
        name: "jinja",
        chaId: "char-jinja",
        chatId: "chat-jinja-1",
        settings: {
            aiModel: "ooba",
            subModel: "ooba",
            instructChatTemplate: "jinja",
            JinjaTemplate: JINJA_TEMPLATE,
            textgenWebUIBlockingURL: "http://localhost:1/api",
            textgenWebUIStreamURL: "ws://localhost:1/api",
        },
        instructTypes: ["chatml", "mistral", "alpaca"],
        previewPrompt: true,
    },
    {
        name: "lore",
        chaId: "char-lore",
        chatId: "chat-lore-1",
        settings: {
            aiModel: "gemini-3-flash-preview",
            subModel: "gemini-3-flash-preview",
            chainOfThought: true,
            personaPrompt: "Lore persona prompt for {{user}}.",
            promptTemplate: LORE_PROMPT_TEMPLATE,
        },
    },
];

const MARKDOWN = {
    chaId: "char-mark",
    chatId: "chat-mark-1",
    // Plugin hooks registered on `pluginHooks` (the seam `processScriptFull` reads; no plugin iframe is
    // loaded). Each appends a marker saying whether it received literal CBS or expanded text.
    hooks: {
        editdisplay:
            "content => content + (/\\{\\{[^{}]*\\}\\}/.test(content) ? ' [display-hook:literal-cbs]' : ' [display-hook:expanded]')",
        editprocess:
            "content => content + (/\\{\\{[^{}]*\\}\\}/.test(content) ? ' [process-hook:literal-cbs]' : ' [process-hook:expanded]')",
    },
};

const TOKEN_TEXTS = {
    ascii: "hello world",
    mixed: "안녕하세요, 世界! Привет 👋🏽 café — naïve",
    special: "a <|endoftext|> b <|im_start|>user<|im_end|> <s> </s> [INST] <|eot_id|>",
    long: { unit: "The quick brown fox jumps over the lazy dog. 다람쥐 헌 쳇바퀴에 타고파. ", times: 2000 },
};

/** `encode` routing: each entry sets these database fields (others stay at the base) and counts TOKEN_TEXTS. */
const TOKEN_CONFIGS = [
    { name: "gpt-o200k", pick: { tokenizer: "tiktokenO200Base", idPrefix: "gpt" } },
    { name: "claude", pick: { tokenizer: "Claude", idPrefix: "claude" } },
    { name: "gemini-no-google-count", settings: { aiModel: "gemini-3-flash-preview", googleClaudeTokenizing: false } },
    { name: "mistral", settings: { aiModel: "mistral-small-latest" } },
    { name: "deepseek", settings: { aiModel: "deepseek-chat" } },
    { name: "deepseek-v4", settings: { aiModel: "deepseek-v4-pro" } },
    { name: "cohere", settings: { aiModel: "cohere-command-r" } },
    { name: "novelai", settings: { aiModel: "novelai" } },
    { name: "novellist", settings: { aiModel: "novellist" } },
    { name: "ooba-llama", settings: { aiModel: "ooba" } },
    { name: "local-hf", settings: { aiModel: "hf:::Xenova/opt-350m" } },
    { name: "openrouter-tik", settings: { aiModel: "openrouter", customTokenizer: "tik" } },
    { name: "reverse-proxy-llama3", settings: { aiModel: "reverse_proxy", customTokenizer: "llama3" } },
    { name: "reverse-proxy-gemma", settings: { aiModel: "reverse_proxy", customTokenizer: "gemma" } },
    { name: "reverse-proxy-claude", settings: { aiModel: "reverse_proxy", customTokenizer: "claude" } },
    { name: "reverse-proxy-glm4", settings: { aiModel: "reverse_proxy", customTokenizer: "glm4" } },
    { name: "reverse-proxy-glm5", settings: { aiModel: "reverse_proxy", customTokenizer: "glm5" } },
    // Custom models: the `LLMTokenizer` fallback table (`encode`'s last block). The numbers are the
    // `LLMTokenizer` values (`shared/llm.ts`): 1 cl100k, 3 Mistral, 8 Llama3, 9 Gemma, 15 GLM4.
    ...[
        ["cl100k", 1],
        ["mistral", 3],
        ["llama3", 8],
        ["gemma", 9],
        ["glm4", 15],
    ].map(([name, tokenizer]) => ({
        name: `custom-model-${name}`,
        settings: {
            aiModel: `xcustom:::baseline-${name}`,
            customModels: [
                {
                    id: `xcustom:::baseline-${name}`,
                    name: `Baseline ${name}`,
                    internalId: `baseline-${name}`,
                    url: "http://localhost:1/never",
                    format: 0,
                    flags: [],
                    tokenizer,
                },
            ],
        },
    })),
    { name: "plugin-legacy-no-options", settings: { aiModel: "custom", currentPluginProvider: "baseline-provider" } },
    {
        name: "plugin-legacy-llama3",
        settings: { aiModel: "custom", currentPluginProvider: "baseline-provider" },
        providerOptions: { tokenizer: "llama3" },
    },
    {
        name: "plugin-legacy-cl100k",
        settings: { aiModel: "custom", currentPluginProvider: "baseline-provider" },
        providerOptions: { tokenizer: "cl100k_base" },
    },
    {
        name: "plugin-legacy-custom-func",
        settings: { aiModel: "custom", currentPluginProvider: "baseline-provider" },
        providerOptions: { tokenizer: "custom", tokenizerFunc: "text => [text.length, 1, 2]" },
    },
];

/** The families the prompt fixtures are counted with (`encodeWithTokenizer` types, and `encode` for o200k). */
const PROMPT_FAMILIES = {
    cl100k_base: { type: "tik" },
    mistral: { type: "mistral" },
    novelai: { type: "novelai" },
    claude: { type: "claude" },
    llama: { type: "llama" },
    llama3: { type: "llama3" },
    novellist: { type: "novellist" },
    gemma: { type: "gemma" },
    cohere: { type: "cohere" },
    DeepSeek: { type: "deepseek" },
    DeepSeekV4: { type: "deepseek-v4" },
    GLM4: { type: "glm4" },
    GLM5: { type: "glm5" },
    o200k_base: { encode: { aiModel: "openrouter", customTokenizer: "tik" } },
};

const LORE_REGEX = {
    chaId: "char-regex",
    scenarios: [
        {
            name: "i-flag-plain-text",
            chatId: "chat-rx-single-plain",
            lore: [lore("regex-i", "/dragon/i", "i flag", { useRegex: true })],
        },
        {
            name: "empty-flags-plain-text",
            chatId: "chat-rx-single-plain",
            lore: [lore("regex-empty", "/dragon/", "empty flags", { useRegex: true })],
        },
        {
            name: "i-flag-slash-in-text",
            chatId: "chat-rx-single-slash",
            lore: [lore("regex-i", "/dragon/i", "i flag", { useRegex: true })],
        },
        {
            name: "i-flag-two-messages-match-second",
            chatId: "chat-rx-two-second",
            lore: [lore("regex-i", "/dragon/i", "i flag", { useRegex: true })],
        },
        {
            name: "i-flag-two-messages-match-first",
            chatId: "chat-rx-two-first",
            lore: [lore("regex-i", "/dragon/i", "i flag", { useRegex: true })],
        },
        {
            name: "two-keys-second-matches",
            chatId: "chat-rx-single-slash",
            lore: [lore("regex-two", "/cat/i, /dragon/i", "two keys", { useRegex: true })],
        },
        { name: "plain-key-control", chatId: "chat-rx-single-plain", lore: [lore("plain", "dragon", "plain key", {})] },
    ],
};

const IGP = {
    chaId: "char-igp",
    chatId: "chat-igp-1",
    userMessage: m("m-i2", "user", "Say something, {{char}}.", 2),
    settings: {
        aiModel: "custom",
        subModel: "custom",
        currentPluginProvider: "baseline-mock",
        igpPrompt: "<|im_start|>system<|im_sep|>Summarize what {{char}} said to {{user}}.<|im_end|>",
    },
    providerReply: "Reply from the mock provider.",
};

const scenario = {
    environment: ENVIRONMENT,
    baseSettings: BASE_SETTINGS,
    personas: PERSONAS,
    presets: PRESETS,
    characters: CHARACTERS,
    prompts: PROMPTS,
    markdown: MARKDOWN,
    tokens: { texts: TOKEN_TEXTS, configs: TOKEN_CONFIGS, promptFamilies: PROMPT_FAMILIES },
    loreRegex: LORE_REGEX,
    igp: IGP,
};

// ---------------------------------------------------------------------------------------------
// Page helpers (run inside the browser).
// ---------------------------------------------------------------------------------------------

const seedScript = `(() => {
    const make = (seed) => {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    };
    let rng = make(${SEED});
    Math.random = () => rng();
    window.__risuReseed = () => { rng = make(${SEED}); };
})();`;

/** The in-page module set every step uses; `applySettings` writes plain fields on the mirror (preset fields through the accessors). */
const pageLib = `
    const stores = await import("/src/ts/stores.svelte.ts");
    const dbm = await import("/src/ts/storage/presets.svelte.ts");
    const views = await import("/src/ts/storage/settingsViews.svelte.ts");
    const selection = await import("/src/ts/storage/selection.svelte.ts");
    const { applyModelFixtureSettings } = await import("/util/playwright/modelProfiles.browser.mjs");
    const characterStore = await import("/src/ts/storage/characterStore.svelte.ts");
    const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
    const proc = await import("/src/ts/process/index.svelte.ts");
    const parser = await import("/src/ts/parser/parser.svelte.ts");
    const transforms = await import("/src/ts/parser/transformClient.ts");
    const hooks = await import("/src/ts/plugins/pluginHooks.ts");
    const lorebook = await import("/src/ts/process/lorebook.svelte.ts");
    const tk = await import("/src/ts/tokenizer.ts");
    const templates = await import("/src/ts/process/templates/chatTemplate.ts");
    const modellist = await import("/src/ts/model/modellist.ts");
    const presets = await import("/shared/presets.ts");
    // The capture's legacy reads stay model ids; model configuration writes select explicit profiles.
    const DBState = { db: new Proxy({}, {
        get(_, key) {
            if (key === "characters") return characterStore.characterList();
            if (key === "botPresetsId") return views.selectedPresetIndex();
            return views.readSettingsRoot(key);
        },
        set(_, key, value) { views.writeSettingsRoot(key, value); return true; },
    }) };
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const applySettings = (configuration) => applyModelFixtureSettings(clone(configuration));
    const selectCharacter = (chaId, chatId) => {
        const index = DBState.db.characters.findIndex((c) => c?.chaId === chaId);
        if (index === -1) throw new Error("no character " + chaId);
        selection.selectCharacter(chaId);
        chatStore.selectChat(chaId, chatId);
        const ref = { chaId, chatId };
        if (!chatStore.findChat(ref)) throw new Error("no chat " + chatId);
        return ref;
    };
    window.__risuReseed();
`;

async function evaluate(page, body, arg) {
    const source = `return (async () => { ${pageLib}\n${body} })();`;
    try {
        return await page.evaluate(new Function("arg", source), arg);
    } catch (error) {
        // The page stack names a line of the generated function (two wrapper lines before `source`).
        const line = Number(/<anonymous>:(\d+):/.exec(String(error))?.[1]);
        if (line) {
            const lines = source.split("\n");
            const from = Math.max(0, line - 2 - 4);
            console.error(
                lines
                    .slice(from, line - 2 + 3)
                    .map((text, i) => `${from + i + 3}: ${text}`)
                    .join("\n"),
            );
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------------------------

const stack = await startStack({ serverPort: 6193, vitePort: 5293 });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
    const context = await browser.newContext({
        viewport: ENVIRONMENT.viewport,
        timezoneId: ENVIRONMENT.timezoneId,
        locale: ENVIRONMENT.locale,
    });
    await context.addInitScript(seedScript);
    const blocked = [];
    await context.route(
        (url) => url.hostname !== "localhost" && url.hostname !== "127.0.0.1",
        (route) => {
            blocked.push(route.request().url());
            return route.fulfill({ status: 500, body: "{}" });
        },
    );
    // At the baseline commit the client's Lua runtime (`scriptings.ts` `makeLuaFactory`, then
    // `new LuaFactory()` with no URL) fetched wasmoon's glue from unpkg at run time; since Stop B it
    // loads the app's own asset. For a recapture of the baseline, the capture answers that request
    // with the installed package's copy of the same version, so no network is used and the bytes
    // are pinned.
    const wasmoonVersion = JSON.parse(
        await readFile(path.join(repoRoot, "node_modules/wasmoon/package.json"), "utf8"),
    ).version;
    const glueWasm = await readFile(path.join(repoRoot, "node_modules/wasmoon/dist/glue.wasm"));
    const servedLocally = [];
    await context.route(`https://unpkg.com/wasmoon@${wasmoonVersion}/dist/glue.wasm`, (route) => {
        servedLocally.push(route.request().url());
        return route.fulfill({ status: 200, body: glueWasm, contentType: "application/wasm" });
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 400)));
    await openApp(page, stack.baseURL);
    // The clock is frozen after boot (the boot measures elapsed time); timers keep running.
    await page.clock.setFixedTime(FIXED_TIME);

    // 1. Seed.
    const seeded = await evaluate(
        page,
        `
        const s = arg;
        DBState.db.didFirstSetup = true;
        DBState.db.useLegacyGUI = true;
        DBState.db.botPresets[0].name = "Default";
        for (const preset of s.presets) {
            DBState.db.botPresets.push(presets.normalizePreset(clone(preset)));
        }
        DBState.db.personas = clone(s.personas);
        applySettings(s.baseSettings);
        for (const character of s.characters) {
            characterStore.addCharacter(clone(character));
        }
        return {
            presetIds: DBState.db.botPresets.map((p) => ({ id: p.id, name: p.name })),
            characters: DBState.db.characters.map((c) => ({
                chaId: c.chaId,
                chats: c.chats.map((chat) => ({ id: chat.id, messages: chat.message.map((m) => m.chatId) })),
            })),
            defaultPresetId: DBState.db.botPresets[0].id,
        };
        `,
        { presets: PRESETS, personas: PERSONAS, baseSettings: BASE_SETTINGS, characters: CHARACTERS },
    );
    for (const character of CHARACTERS) {
        const got = seeded.characters.find((c) => c.chaId === character.chaId);
        if (!got) throw new Error(`character ${character.chaId} was not added`);
        for (const chat of character.chats) {
            const gotChat = got.chats.find((c) => c.id === chat.id);
            if (!gotChat) throw new Error(`chat ${chat.id} lost its id`);
            const want = chat.message.map((m) => m.chatId).join(",");
            if (gotChat.messages.join(",") !== want)
                throw new Error(`chat ${chat.id} message ids changed: ${gotChat.messages}`);
        }
    }

    // 2. Markdown (the character is selected: the display trigger runs on the selection).
    const markdown = await evaluate(
        page,
        `
        const { md, baseSettings, defaultPresetId } = arg;
        dbm.changeToPreset(defaultPresetId, true);
        applySettings(baseSettings);
        const ref = selectCharacter(md.chaId, md.chatId);
        const index = DBState.db.characters.findIndex((c) => c?.chaId === md.chaId);
        const char = DBState.db.characters[index];
        const chat = chatStore.findChat(ref);
        const capture = async () => {
            const out = {};
            const one = async (data, idx, cbsConditions) => {
                const result = {};
                window.__risuReseed();
                result.direct = await parser.ParseMarkdown(data, char, "normal", idx, cbsConditions);
                window.__risuReseed();
                const prePassed = parser.risuChatParser(data, { chara: char.name, chatID: idx, rmVar: true, visualize: true, cbsConditions });
                result.prePass = { text: prePassed, html: await parser.ParseMarkdown(prePassed, char, "normal", idx, cbsConditions) };
                window.__risuReseed();
                result.back = await parser.ParseMarkdown(data, char, "back", idx, cbsConditions);
                window.__risuReseed();
                result.editprocess = await transforms.serverProcessScript(char, data, "editprocess", idx, cbsConditions, transforms.captureTransform(ref), "text");
                return result;
            };
            out.greeting = await one(char.firstMessage, -1, { firstmsg: true, chatRole: "char" });
            out.messages = {};
            for (let i = 0; i < chat.message.length; i++) {
                const message = chat.message[i];
                out.messages[message.chatId] = await one(message.data, i, { firstmsg: false, chatRole: message.role });
            }
            return out;
        };
        const result = { withoutHooks: await capture() };
        const display = new Function("return " + md.hooks.editdisplay)();
        const process = new Function("return " + md.hooks.editprocess)();
        hooks.pluginHooks.editdisplay.add(display);
        hooks.pluginHooks.editprocess.add(process);
        try {
            result.withHooks = await capture();
        } finally {
            hooks.pluginHooks.editdisplay.delete(display);
            hooks.pluginHooks.editprocess.delete(process);
        }
        return result;
        `,
        { md: MARKDOWN, baseSettings: BASE_SETTINGS, defaultPresetId: seeded.defaultPresetId },
    );

    // 3. Lore regex.
    const loreRegex = await evaluate(
        page,
        `
        const { lr, baseSettings, defaultPresetId } = arg;
        dbm.changeToPreset(defaultPresetId, true);
        applySettings(baseSettings);
        const out = {};
        for (const scenario of lr.scenarios) {
            characterStore.updateCharacter(lr.chaId, { globalLore: clone(scenario.lore) });
            const ref = selectCharacter(lr.chaId, scenario.chatId);
            window.__risuReseed();
            const result = await lorebook.loadLoreBookV3Prompt(ref);
            out[scenario.name] = {
                messages: chatStore.findChat(ref).message.map((m) => m.data),
                lore: scenario.lore.map((l) => ({ comment: l.comment, key: l.key, useRegex: l.useRegex ?? false })),
                actives: result.actives.map((a) => ({ source: a.source, prompt: a.prompt, pos: a.pos, depth: a.depth, role: a.role })),
                matchLog: clone(result.matchLog),
            };
        }
        characterStore.updateCharacter(lr.chaId, { globalLore: [] });
        return out;
        `,
        { lr: LORE_REGEX, baseSettings: BASE_SETTINGS, defaultPresetId: seeded.defaultPresetId },
    );

    // 4. igp: a real send through a mock plugin provider, on the base (legacy template) settings.
    const igp = await evaluate(
        page,
        `
        const { igp, baseSettings, defaultPresetId } = arg;
        dbm.changeToPreset(defaultPresetId, true);
        applySettings(baseSettings);
        applySettings(igp.settings);
        const ref = selectCharacter(igp.chaId, igp.chatId);
        const calls = [];
        const provider = async (providerArg) => {
            calls.push({ mode: providerArg.mode, max_tokens: providerArg.max_tokens, prompt_chat: clone(providerArg.prompt_chat) });
            return { success: true, content: igp.providerReply };
        };
        hooks.pluginHooks.providers.set(igp.settings.currentPluginProvider, provider);
        try {
            chatStore.appendMessage(ref, clone(igp.userMessage));
            window.__risuReseed();
            const ok = await proc.sendChat(-1);
            proc.doingChat.set(false);
            const chat = chatStore.findChat(ref);
            return {
                sendResult: ok,
                providerCalls: calls,
                messages: chat.message.map((m) => ({ role: m.role, saying: m.saying ?? null, data: m.data })),
            };
        } finally {
            hooks.pluginHooks.providers.delete(igp.settings.currentPluginProvider);
        }
        `,
        { igp: IGP, baseSettings: BASE_SETTINGS, defaultPresetId: seeded.defaultPresetId },
    );

    // 5. Prompts.
    const prompts = {};
    for (const fixture of PROMPTS) {
        prompts[fixture.name] = await evaluate(
            page,
            `
            const { fixture, baseSettings, defaultPresetId } = arg;
            dbm.changeToPreset(defaultPresetId, true);
            applySettings(baseSettings);
            applySettings(fixture.settings);
            selectCharacter(fixture.chaId, fixture.chatId);
            window.__risuReseed();
            const ok = await proc.sendChat(-1, { preview: true });
            proc.doingChat.set(false);
            if (!ok) throw new Error("preview failed for " + fixture.name);
            const formated = clone(proc.previewFormated);
            const out = { formated };
            out.selectedPresetName = DBState.db.botPresets[DBState.db.botPresetsId]?.name ?? null;
            if (fixture.instructTypes) {
                out.instruct = { [DBState.db.instructChatTemplate]: templates.applyChatTemplate(clone(formated)) };
                for (const type of fixture.instructTypes) {
                    out.instruct[type] = templates.applyChatTemplate(clone(formated), { type });
                }
            }
            if (fixture.previewPrompt) {
                window.__risuReseed();
                const ok2 = await proc.sendChat(-1, { previewPrompt: true });
                proc.doingChat.set(false);
                if (!ok2) throw new Error("previewPrompt failed for " + fixture.name);
                out.previewBody = JSON.parse(proc.previewBody);
            }
            if (fixture.restorePreset) {
                dbm.changeToPreset(defaultPresetId, true);
            }
            return out;
            `,
            { fixture, baseSettings: BASE_SETTINGS, defaultPresetId: seeded.defaultPresetId },
        );
    }

    // 6. Tokens.
    const tokens = await evaluate(
        page,
        `
        const { texts, configs, families, promptFixtures, baseSettings, defaultPresetId } = arg;
        dbm.changeToPreset(defaultPresetId, true);
        applySettings(baseSettings);
        const fnv = (ids) => {
            let h = 0x811c9dc5;
            for (const ch of Array.from(ids).join(",")) {
                h ^= ch.charCodeAt(0);
                h = Math.imul(h, 0x01000193) >>> 0;
            }
            return h;
        };
        const materialize = (t) => (typeof t === "string" ? t : t.unit.repeat(t.times));
        const record = async (fn, name) => {
            try {
                const ids = await fn(materialize(texts[name]));
                return name === "long" ? { count: ids.length, hash: fnv(ids) } : { ids: Array.from(ids) };
            } catch (e) {
                return { error: e instanceof Error ? e.message : String(e) };
            }
        };
        const tokenizerName = (value) => Object.entries(modellist.LLMTokenizer).find(([, v]) => v === value)?.[0] ?? String(value);
        const routing = {};
        for (const config of configs) {
            let settings = config.settings ?? {};
            if (config.pick) {
                const want = modellist.LLMTokenizer[config.pick.tokenizer];
                const model = modellist.LLMModels.find(
                    (m) => m.tokenizer === want && (!config.pick.idPrefix || m.id.startsWith(config.pick.idPrefix)),
                );
                if (!model) throw new Error("no model for " + JSON.stringify(config.pick));
                settings = { aiModel: model.id };
            }
            applySettings({ customTokenizer: "tik", currentPluginProvider: "", customModels: [], googleClaudeTokenizing: false, ...settings });
            hooks.pluginHooks.providerOptions.delete("baseline-provider");
            if (config.providerOptions) {
                const options = { ...config.providerOptions };
                if (options.tokenizerFunc) options.tokenizerFunc = new Function("return " + options.tokenizerFunc)();
                hooks.pluginHooks.providerOptions.set("baseline-provider", options);
            }
            const entry = { settings, resolvedTokenizer: tokenizerName(modellist.getModelInfo(DBState.db.aiModel).tokenizer), texts: {} };
            if (config.providerOptions) entry.providerOptions = config.providerOptions;
            for (const name of Object.keys(texts)) entry.texts[name] = await record((t) => tk.encode(t), name);
            routing[config.name] = entry;
        }
        hooks.pluginHooks.providerOptions.delete("baseline-provider");
        applySettings(baseSettings);
        const prompts = {};
        for (const [fixtureName, formated] of Object.entries(promptFixtures)) {
            const perFamily = {};
            for (const [family, how] of Object.entries(families)) {
                const encodeOne = how.type
                    ? (t) => tk.encodeWithTokenizer(t, how.type)
                    : (applySettings(how.encode), (t) => tk.encode(t));
                const counts = [];
                for (const message of formated) counts.push((await encodeOne(message.content)).length);
                perFamily[family] = { perMessage: counts, total: counts.reduce((a, b) => a + b, 0) };
                applySettings(baseSettings);
            }
            prompts[fixtureName] = perFamily;
        }
        return { routing, prompts };
        `,
        {
            texts: TOKEN_TEXTS,
            configs: TOKEN_CONFIGS,
            families: PROMPT_FAMILIES,
            promptFixtures: Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, v.formated])),
            baseSettings: BASE_SETTINGS,
            defaultPresetId: seeded.defaultPresetId,
        },
    );

    const provenance = {
        commit: execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim(),
        capturedAt: new Date().toISOString(),
        chrome: execSync(`"${chromePath}" --version`).toString().trim(),
        playwrightCore: JSON.parse(
            await readFile(path.join(repoRoot, "node_modules/playwright-core/package.json"), "utf8"),
        ).version,
        wasmoon: wasmoonVersion,
        client: "the browser path unchanged at the commit above, Vite dev stack (util/playwright/stack.mjs), fresh server working directory",
        tool: "util/playwright/capturePhase5Baseline.mjs",
        pageErrors: [...new Set(pageErrors)].map((text) => ({
            text,
            times: pageErrors.filter((e) => e === text).length,
        })),
        blockedRequests: [...new Set(blocked)].map((url) => ({ url, times: blocked.filter((u) => u === url).length })),
        servedLocally: [...new Set(servedLocally)].map((url) => ({
            url,
            times: servedLocally.filter((u) => u === url).length,
        })),
        presetIds: seeded.presetIds,
    };

    await mkdir(outDir, { recursive: true });
    const write = async (name, data) => {
        const file = path.join(outDir, name);
        const options = (await prettier.resolveConfig(file)) ?? {};
        await writeFile(file, await prettier.format(JSON.stringify(data), { ...options, filepath: file }));
    };
    await write("scenario.json", scenario);
    await write("prompts.json", prompts);
    await write("markdown.json", markdown);
    await write("token-counts.json", tokens);
    await write("lore-regex.json", loreRegex);
    await write("igp.json", igp);
    await write("provenance.json", provenance);
    console.log(`Wrote the baseline fixtures to ${outDir}`);
    console.log("page errors:", JSON.stringify(provenance.pageErrors));
    console.log("blocked requests:", JSON.stringify(provenance.blockedRequests));
    console.log("served locally:", JSON.stringify(provenance.servedLocally));
} finally {
    await browser.close();
    await stack.stop();
}
