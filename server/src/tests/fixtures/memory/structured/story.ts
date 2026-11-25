// A deterministic story for the Structured Memory evaluation (not a test file itself). Pure: the only
// inputs are the language, the turn count, and the seed, and the only randomness is the generator's own
// PRNG, so two runs give the same chat byte for byte. Nothing generated is committed; the word lists
// and the rules are the fixture.
//
// A story is a chat of `turns` turns (a user message and a reply each) over a cast of ten, six places,
// and eight items. Scenes change every few turns; each turn has one plot beat (a gift, a hiding, a
// find, a promise, a kept promise, a quarrel, a secret, or talk). The reply holds the beat's key
// sentence and two detail lines verbatim, which the scripted answer quotes as its three key lines (no
// quoted line repeats across turns), under a summary in other words; that answer (`analysis`,
// `patches`) is written beside the messages. A fixed set of beats sits at known turns so that the labelled probes always
// have their records: the probe of each kind the design names, with the record labels it needs, the
// ones that must stay out, and the setup a probe takes (a retraction, a message edit, a page hidden).
//
// Pages are named by title here; the scripted writer swaps the ids in from the prompt's page list, as
// the format tells a model to. Labels are `event:<turn>`, `page:<title>`, and `thread:<title>`.

import type { MemoryAxes, MemoryPageType } from "../../../../../../shared/structuredMemory.ts";

export type StoryLanguage = "ko" | "en";

export type StoryOptions = {
    language: StoryLanguage;
    /** At least `MIN_STORY_TURNS`. */
    turns: number;
    seed?: number;
};

/** Fewer turns leave no room for every beat the probes need. */
export const MIN_STORY_TURNS = 20;

export type StoryKind =
    "travel" | "give" | "hide" | "find" | "promise" | "resolve" | "argue" | "secret" | "chat" | "smallTalk";

/** How a section of a page changes: a whole new body, a line added or removed, or a line appended. */
export type SectionScript = { heading: string; op: "replace" | "append" | "addLine" | "removeLine"; text: string };

/** The pages a turn's patch call changes, by title. */
export type PatchScript = { title: string; type: MemoryPageType; sections: SectionScript[] };

export type StoryKnowledge = {
    pageId: string;
    fact: string;
    stance: "knows" | "believes";
    quote: string;
    knowers?: string[];
};

/** The scripted analysis answer of one turn, with pages named by title. */
export type AnalysisScript = {
    title: string;
    summary: string;
    participants: string[];
    storyTime: { text: string };
    keyLines: { speaker: string; text: string }[];
    stateChanges: { pageId: string; section: string; before: string; after: string; quote: string }[];
    knowledge: StoryKnowledge[];
    relationshipShifts: { from: string; to: string; direction: string; note: string }[];
    openThreads: { add: { title: string; who: string[] }[]; close: string[] };
    axes: MemoryAxes;
    /** The pages the event changes: the patch call's targets, created when missing. */
    pages: { title: string; type: MemoryPageType }[];
    scene: { participants: string[]; place: string; time: string; state: string };
};

export type TurnScript = {
    turn: number;
    userId: string;
    charId: string;
    user: string;
    char: string;
    kind: StoryKind;
    analysis: AnalysisScript;
    patches: PatchScript[];
};

export type ProbeKind = "needed" | "mustNotLeak" | "knowledge" | "comparison" | "unanswerable";

/** What the harness does to the records before a probe runs. */
export type ProbeSetup =
    | { kind: "retract"; label: string }
    | { kind: "editMessage"; messageId: string; text: string }
    | { kind: "never"; label: string };

export type Probe = {
    id: string;
    kind: ProbeKind;
    query: string;
    /** Labels that must be in the manifest. */
    needed: string[];
    /** Labels that must stay out of it. */
    forbidden: string[];
    /** Labelled real records sharing a word with an unanswerable query. */
    distractors: string[];
    /** A knowledge probe: the on-stage character and the fact only the holder knows. */
    boundary?: { page: string; fact: string };
    /** The records whose text the query mirrors, for the similarity diagnostic. */
    mirrors: string[];
    setup?: ProbeSetup;
    /** What the probe tests, in the export's rubric. */
    note: string;
};

export type Story = {
    language: StoryLanguage;
    seed: number;
    turns: TurnScript[];
    cast: string[];
    places: string[];
    items: string[];
    names: { character: string; persona: string; greeting: string };
    /** The titles present in the final scene. */
    finalStage: string[];
    probes: Probe[];
};

// ---------------------------------------------------------------------------------------------
// Words

type Words = {
    cast: string[];
    places: string[];
    items: string[];
    times: string[];
    fillers: string[];
    userLines: string[];
    smallTalk: string[];
    character: string;
    persona: string;
    greeting: string;
};

const EN: Words = {
    cast: ["Mira", "Teo", "Lysa", "Bram", "Ione", "Kael", "Nessa", "Orin", "Pell", "Sable"],
    places: ["Harbor", "Old bridge", "Mill", "Chapel", "Market", "Lighthouse"],
    items: [
        "Silver flute",
        "Brass key",
        "Red lantern",
        "Sealed letter",
        "Iron compass",
        "Blue cloak",
        "Clay jar",
        "Worn map",
    ],
    times: ["morning", "noon", "evening", "night"],
    fillers: [
        "The wind moved through the reeds.",
        "Someone laughed further down the road.",
        "A gull circled twice and settled.",
        "The smell of bread drifted from a doorway.",
        "Rain had left the stones dark and slick.",
        "A cart creaked past, its driver half asleep.",
        "Candles guttered in the draft.",
        "The bell had not rung yet.",
        "Footsteps echoed and faded.",
        "Dust hung in a slant of light.",
        "The tide was turning.",
        "A dog barked once and thought better of it.",
        "Clouds piled up over the hills.",
        "The fire settled into embers.",
        "Nobody spoke for a while.",
        "The air tasted of salt and smoke.",
    ],
    userLines: [
        "I look around and wait.",
        "I follow quietly.",
        "I nod and say nothing.",
        "I keep to the shadows and listen.",
        "I step closer.",
        "I sit down on the low wall.",
        "I offer to help carry things.",
        "I ask what comes next.",
    ],
    smallTalk: [
        "They spoke of the weather and let the {T} pass.",
        "They shared bread without a word.",
        "They watched the light change.",
    ],
    character: "Narrator",
    persona: "Traveler",
    greeting: "The road bends toward the coast. Come along.",
};

const KO: Words = {
    cast: ["미라", "태오", "리사", "브람", "이온", "하연", "나래", "오린", "벨라", "세빈"],
    places: ["항구", "오래된 다리", "방앗간", "예배당", "시장", "등대"],
    items: ["은빛 피리", "놋쇠 열쇠", "붉은 등불", "봉인된 편지", "쇠 나침반", "푸른 망토", "질그릇", "낡은 지도"],
    times: ["아침", "낮", "저녁", "밤"],
    fillers: [
        "바람이 갈대 사이로 지나갔다.",
        "멀리서 누군가 웃는 소리가 들렸다.",
        "갈매기 한 마리가 두 바퀴를 돌고 내려앉았다.",
        "문간에서 빵 냄새가 흘러나왔다.",
        "비가 남긴 돌바닥이 어둡고 미끄러웠다.",
        "수레 하나가 삐걱거리며 지나갔다.",
        "촛불이 바람에 흔들렸다.",
        "종은 아직 울리지 않았다.",
        "발소리가 울리다가 잦아들었다.",
        "먼지가 비스듬한 빛 속에 떠 있었다.",
        "물때가 바뀌고 있었다.",
        "개 한 마리가 한 번 짖고는 그만두었다.",
        "구름이 언덕 위로 쌓여 갔다.",
        "불이 잦아들어 잉걸불이 되었다.",
        "한동안 아무도 말하지 않았다.",
        "공기에서 소금과 연기 맛이 났다.",
    ],
    userLines: [
        "나는 주위를 둘러보며 기다린다.",
        "나는 조용히 뒤따른다.",
        "나는 고개를 끄덕이고 아무 말도 하지 않는다.",
        "나는 그늘에 서서 귀를 기울인다.",
        "나는 한 걸음 다가선다.",
        "나는 낮은 담에 걸터앉는다.",
        "나는 짐 나르는 것을 돕겠다고 한다.",
        "나는 다음에 무엇을 할지 묻는다.",
    ],
    smallTalk: [
        "그들은 날씨 이야기를 하며 {T}을 흘려보냈다.",
        "그들은 말없이 빵을 나누어 먹었다.",
        "그들은 빛이 바뀌는 것을 지켜보았다.",
    ],
    character: "서술자",
    persona: "나그네",
    greeting: "길은 해안 쪽으로 굽어 있다. 함께 가자.",
};

const WORDS: Record<StoryLanguage, Words> = { en: EN, ko: KO };

// ---------------------------------------------------------------------------------------------
// Deterministic randomness

/** mulberry32: a small PRNG whose whole state is one 32-bit word. */
function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

type Random = {
    int(bound: number): number;
    pick<T>(list: readonly T[]): T;
    /** `count` distinct members of `list`, in a random order. */
    sample<T>(list: readonly T[], count: number): T[];
};

function randomOf(next: () => number): Random {
    const int = (bound: number) => Math.min(bound - 1, Math.floor(next() * bound));
    return {
        int,
        pick: (list) => list[int(list.length)],
        sample(list, count) {
            const pool = [...list];
            const taken: (typeof pool)[number][] = [];
            while (taken.length < count && pool.length > 0) {
                taken.push(pool.splice(int(pool.length), 1)[0]);
            }
            return taken;
        },
    };
}

// ---------------------------------------------------------------------------------------------
// Language

/** Whether a Hangul syllable ends in a final consonant, which picks the particle after it. */
function batchim(word: string): boolean {
    const code = word.codePointAt(word.length - 1) ?? 0;
    return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
}

/** A Korean particle pair after `word`: `이/가`, `을/를`, `은/는`, `과/와`, `으로/로`. */
function josa(word: string, pair: "이가" | "을를" | "은는" | "과와" | "으로로"): string {
    const final = batchim(word);
    switch (pair) {
        case "이가":
            return final ? "이" : "가";
        case "을를":
            return final ? "을" : "를";
        case "은는":
            return final ? "은" : "는";
        case "과와":
            return final ? "과" : "와";
        case "으로로": {
            const code = word.codePointAt(word.length - 1) ?? 0;
            return final && (code - 0xac00) % 28 !== 8 ? "으로" : "로";
        }
    }
}

/** A place or item as the English text names it: lower case, with its article. */
const named = (title: string) => `the ${title.toLowerCase()}`;

/** The pieces a sentence is built from; every template reads them. */
type Slots = { A: string; B: string; P: string; I: string; T: string; day: number };

type Phrase = (slots: Slots) => string;

/** The key sentences by beat, which the reply holds verbatim and the summary repeats. */
const KEY: Record<StoryLanguage, Record<StoryKind, Phrase>> = {
    en: {
        travel: ({ A, B, P, T }) => `${A} and ${B} came up the road to ${named(P)} as the ${T} settled.`,
        give: ({ A, B, P, I }) => `${A} handed ${named(I)} to ${B} at ${named(P)}.`,
        hide: ({ A, P, I }) => `${A} hid ${named(I)} under a stone at ${named(P)}.`,
        find: ({ A, P, I }) => `${A} found ${named(I)} half buried near ${named(P)}.`,
        promise: ({ A, B, P, T }) => `${A} promised ${B} to come back to ${named(P)} by the next ${T}.`,
        resolve: ({ A, B, P }) => `${A} kept the promise and met ${B} at ${named(P)}.`,
        argue: ({ A, B, I }) => `${A} and ${B} argued bitterly over ${named(I)}.`,
        secret: ({ A, B, P, I }) => `${A} whispered to ${B} that ${named(I)} was buried behind ${named(P)}.`,
        chat: ({ A, B, T }) => `${A} and ${B} talked quietly about the ${T}.`,
        smallTalk: () => "",
    },
    ko: {
        travel: ({ A, B, P, T }) => `${A}${josa(A, "과와")} ${B}${josa(B, "이가")} ${T} 무렵 ${P}에 다다랐다.`,
        give: ({ A, B, P, I }) => `${A}${josa(A, "이가")} ${P}에서 ${B}에게 ${I}${josa(I, "을를")} 건넸다.`,
        hide: ({ A, P, I }) => `${A}${josa(A, "이가")} ${P}의 돌 밑에 ${I}${josa(I, "을를")} 숨겼다.`,
        find: ({ A, P, I }) => `${A}${josa(A, "이가")} ${P} 근처에서 반쯤 묻힌 ${I}${josa(I, "을를")} 찾아냈다.`,
        promise: ({ A, B, P, T }) =>
            `${A}${josa(A, "이가")} 다음 ${T}까지 ${P}${josa(P, "으로로")} 돌아오겠다고 ${B}에게 약속했다.`,
        resolve: ({ A, B, P }) => `${A}${josa(A, "이가")} 약속을 지켜 ${P}에서 ${B}${josa(B, "을를")} 만났다.`,
        argue: ({ A, B, I }) =>
            `${A}${josa(A, "과와")} ${B}${josa(B, "이가")} ${I}${josa(I, "을를")} 두고 심하게 다투었다.`,
        secret: ({ A, B, P, I }) =>
            `${A}${josa(A, "이가")} ${B}에게 ${I}${josa(I, "이가")} ${P} 뒤에 묻혀 있다고 속삭였다.`,
        chat: ({ A, B, T }) => `${A}${josa(A, "과와")} ${B}${josa(B, "이가")} ${T}에 대해 조용히 이야기를 나누었다.`,
        smallTalk: () => "",
    },
};

const TITLE: Record<StoryLanguage, Record<StoryKind, Phrase>> = {
    en: {
        travel: ({ A, B, P }) => `${A} and ${B} reach ${named(P)}`,
        give: ({ A, B, I }) => `${A} gives ${B} ${named(I)}`,
        hide: ({ A, I }) => `${A} hides ${named(I)}`,
        find: ({ A, I }) => `${A} finds ${named(I)}`,
        promise: ({ A, B }) => `${A} makes ${B} a promise`,
        resolve: ({ A, B }) => `${A} keeps the promise to ${B}`,
        argue: ({ A, B }) => `${A} and ${B} quarrel`,
        secret: ({ A, B }) => `${A} tells ${B} a secret`,
        chat: ({ A, B }) => `${A} and ${B} talk`,
        smallTalk: ({ day }) => `Quiet talk on day ${day}`,
    },
    ko: {
        travel: ({ A, B, P }) => `${A}${josa(A, "과와")} ${B}, ${P}에 도착`,
        give: ({ A, B, I }) => `${A}, ${B}에게 ${I} 건넴`,
        hide: ({ A, I }) => `${A}, ${I} 숨김`,
        find: ({ A, I }) => `${A}, ${I} 찾음`,
        promise: ({ A, B }) => `${A}, ${B}에게 약속`,
        resolve: ({ A, B }) => `${A}, ${B}${josa(B, "과와")}의 약속을 지킴`,
        argue: ({ A, B }) => `${A}${josa(A, "과와")} ${B}의 다툼`,
        secret: ({ A, B }) => `${A}, ${B}에게 비밀을 말함`,
        chat: ({ A, B }) => `${A}${josa(A, "과와")} ${B}의 대화`,
        smallTalk: ({ day }) => `${day}일째의 한담`,
    },
};

/** The summaries by beat: the event in the writer's own words, never a sentence of the reply. */
const SUMMARY: Record<StoryLanguage, Record<StoryKind, Phrase>> = {
    en: {
        travel: ({ A, B, P, T }) => `At ${named(P)}, ${A} and ${B} arrived with the ${T}.`,
        give: ({ A, B, P, I }) => `${B} received ${named(I)} from ${A} at ${named(P)}.`,
        hide: ({ A, P, I }) => `${named(I)} now lies under a stone at ${named(P)}, where ${A} put it.`,
        find: ({ A, P, I }) => `${A} now carries ${named(I)}, dug up near ${named(P)}.`,
        promise: ({ A, B, P, T }) => `${A} owes ${B} a return to ${named(P)} by the next ${T}.`,
        resolve: ({ A, B, P }) => `${A} met ${B} at ${named(P)} as promised.`,
        argue: ({ A, B, I }) => `A bitter quarrel over ${named(I)} between ${A} and ${B}.`,
        secret: ({ A, B, P, I }) => `${B} learned from ${A} that ${named(I)} is buried behind ${named(P)}.`,
        chat: ({ A, B, T }) => `Quiet talk between ${A} and ${B} about the ${T}.`,
        smallTalk: ({ day, T }) => `Idle talk on day ${day}, ${T}.`,
    },
    ko: {
        travel: ({ A, B, P, T }) => `${T} 무렵 ${A}${josa(A, "과와")} ${B}${josa(B, "이가")} ${P}에 도착했다.`,
        give: ({ A, B, P, I }) => `${B}${josa(B, "이가")} ${P}에서 ${A}에게서 ${I}${josa(I, "을를")} 받았다.`,
        hide: ({ A, P, I }) => `${I}${josa(I, "은는")} 이제 ${P}의 돌 밑에 있다. ${A}${josa(A, "이가")} 둔 것이다.`,
        find: ({ A, P, I }) => `${A}${josa(A, "은는")} 이제 ${P} 근처에서 파낸 ${I}${josa(I, "을를")} 지니고 있다.`,
        promise: ({ A, B, P, T }) =>
            `${A}${josa(A, "은는")} 다음 ${T}까지 ${P}${josa(P, "으로로")} 돌아갈 것을 ${B}에게 빚졌다.`,
        resolve: ({ A, B, P }) => `${A}${josa(A, "이가")} 약속대로 ${P}에서 ${B}${josa(B, "을를")} 만났다.`,
        argue: ({ A, B, I }) => `${I}${josa(I, "을를")} 두고 ${A}${josa(A, "과와")} ${B} 사이에 심한 다툼이 있었다.`,
        secret: ({ A, B, P, I }) =>
            `${B}${josa(B, "은는")} ${A}에게서 ${I}${josa(I, "이가")} ${P} 뒤에 묻혀 있음을 들었다.`,
        chat: ({ A, B, T }) => `${A}${josa(A, "과와")} ${B}${josa(B, "이가")} ${T}에 대해 조용히 이야기했다.`,
        smallTalk: ({ day, T }) => `${day}일째 ${T}의 한담.`,
    },
};

/**
 * Two more lines of each reply the writer quotes, unique to their turn by its number, with no name, place,
 * item, or cue word in them.
 */
const DETAILS: Record<StoryLanguage, ((turn: number) => string)[]> = {
    en: [
        (turn) => `Someone had counted ${turn} steps from the door by then.`,
        (turn) => `The lamp wick had been trimmed ${turn} times since dawn.`,
    ],
    ko: [
        (turn) => `누군가 그 무렵까지 문에서 ${turn}걸음을 세어 두었다.`,
        (turn) => `동이 튼 뒤로 등잔 심지는 ${turn}번 다듬어져 있었다.`,
    ],
};

/** What tells a repeated key sentence from its earlier twin: a tail in English, a lead in Korean. */
const VARIANTS: Record<StoryLanguage, string[]> = {
    en: [
        "",
        " for a while",
        " as the hours went",
        " without hurry",
        " at the edge of the light",
        " under a low sky",
        " by the dying fire",
        " with the shutters open",
    ],
    ko: [
        "",
        "한동안 ",
        "서두르지 않고 ",
        "빛의 가장자리에서 ",
        "낮은 하늘 아래 ",
        "꺼져 가는 불가에서 ",
        "덧문을 열어 둔 채 ",
        "느릿느릿 ",
    ],
};

/** `sentence` as no earlier turn quoted it: the first variant not in `used`, or the sentence itself as a last resort. */
function uniqueLine(language: StoryLanguage, sentence: string, used: Set<string>): string {
    for (const variant of VARIANTS[language]) {
        const line = language === "en" ? `${sentence.replace(/\.$/, "")}${variant}.` : `${variant}${sentence}`;
        if (!used.has(line)) {
            used.add(line);
            return line;
        }
    }
    used.add(sentence);
    return sentence;
}

/** The secret's fact, the one text every record of it states. */
const FACT: Record<StoryLanguage, Phrase> = {
    en: ({ P, I }) => `${named(I)} is buried behind ${named(P)}`,
    ko: ({ P, I }) => `${I}${josa(I, "이가")} ${P} 뒤에 묻혀 있다`,
};

const THREAD: Record<StoryLanguage, Phrase> = {
    en: ({ A, B }) => `${A}'s promise to ${B}`,
    ko: ({ A, B }) => `${B}에게 한 ${A}의 약속`,
};

const STORY_TIME: Record<StoryLanguage, Phrase> = {
    en: ({ day, T }) => `Day ${day}, ${T}`,
    ko: ({ day, T }) => `${day}일째 ${T}`,
};

const SCENE_STATE: Record<StoryLanguage, (present: readonly string[], P: string) => string> = {
    en: (present, P) => `${present.join(", ")} are at ${named(P)}.`,
    ko: (present, P) => `${present.join(", ")}${josa(present[present.length - 1], "이가")} ${P}에 있다.`,
};

/** The text of a character's `currentState` slot. */
const CURRENT_STATE: Record<StoryLanguage, Phrase> = {
    en: ({ P, T, day }) => `At ${named(P)} on day ${day}, ${T}.`,
    ko: ({ P, T, day }) => `${day}일째 ${T}, ${P}에 있음.`,
};

type Lines = {
    heldBy: Phrase;
    hiddenAt: Phrase;
    foundNear: Phrase;
    buried: Phrase;
    strained: Phrase;
    warmer: Phrase;
    goal: Phrase;
    kept: Phrase;
    knowsSecret: Phrase;
    hidKnowledge: Phrase;
    quarrelNote: Phrase;
};

const LINES: Record<StoryLanguage, Lines> = {
    en: {
        heldBy: ({ B, day }) => `Held by ${B} since day ${day}.`,
        hiddenAt: ({ A, P, day }) => `Hidden under a stone at ${named(P)} by ${A} (day ${day}).`,
        foundNear: ({ A, P, day }) => `Held by ${A} since day ${day}, found near ${named(P)}.`,
        buried: ({ P }) => `Buried behind ${named(P)}; a secret.`,
        strained: ({ B, I, day }) => `${B}: strained after the quarrel over ${named(I)} (day ${day}).`,
        warmer: ({ B, day }) => `${B}: warmer after the kept promise (day ${day}).`,
        goal: ({ B, P, T }) => `Come back to ${named(P)} for ${B} by the next ${T}.`,
        kept: ({ B, P }) => `Kept the promise to ${B} at ${named(P)}.`,
        knowsSecret: ({ B, P, I }) => `Knows ${named(I)} is buried behind ${named(P)} (shared with ${B}).`,
        hidKnowledge: ({ P, I }) => `Hid ${named(I)} at ${named(P)}.`,
        quarrelNote: ({ A, B, day }) => `Quarrel between ${A} and ${B} (day ${day}).`,
    },
    ko: {
        heldBy: ({ B, day }) => `${day}일째부터 ${B}${josa(B, "이가")} 지니고 있음.`,
        hiddenAt: ({ A, P, day }) => `${A}${josa(A, "이가")} ${P}의 돌 밑에 숨김 (${day}일째).`,
        foundNear: ({ A, P, day }) => `${day}일째부터 ${A}${josa(A, "이가")} 지니고 있음, ${P} 근처에서 찾음.`,
        buried: ({ P }) => `${P} 뒤에 묻혀 있음; 비밀.`,
        strained: ({ B, I, day }) => `${B}: ${I}${josa(I, "을를")} 두고 다툰 뒤 서먹함 (${day}일째).`,
        warmer: ({ B, day }) => `${B}: 약속을 지킨 뒤 가까워짐 (${day}일째).`,
        goal: ({ B, P, T }) => `다음 ${T}까지 ${B}${josa(B, "을를")} 위해 ${P}${josa(P, "으로로")} 돌아가기.`,
        kept: ({ B, P }) => `${P}에서 ${B}에게 한 약속을 지킴.`,
        knowsSecret: ({ B, P, I }) => `${I}${josa(I, "이가")} ${P} 뒤에 묻혀 있음을 앎 (${B}${josa(B, "과와")} 공유).`,
        hidKnowledge: ({ P, I }) => `${I}${josa(I, "을를")} ${P}에 숨김.`,
        quarrelNote: ({ A, B, day }) => `${A}${josa(A, "과와")} ${B}의 다툼 (${day}일째).`,
    },
};

type Queries = {
    needed: Phrase;
    promise: Phrase;
    comparison: (hide: Slots, find: Slots) => string;
    retracted: Phrase;
    stale: Phrase;
    never: Phrase;
    knowledge: Phrase;
    unanswerable: Phrase;
    control: string;
};

const QUERIES: Record<StoryLanguage, Queries> = {
    en: {
        needed: ({ A, B, P, I }) => `Do you remember when ${A} handed ${named(I)} to ${B} at ${named(P)}?`,
        promise: ({ A, B }) => `Do you remember what ${A} promised ${B}?`,
        comparison: (hide, find) =>
            `Do you remember where ${hide.A} hid ${named(hide.I)}, and where ${find.A} found ${named(find.I)} later?`,
        retracted: ({ A, B, I }) => `Do you remember how ${A} and ${B} argued bitterly over ${named(I)}?`,
        stale: ({ A, P, I }) => `Do you remember when ${A} found ${named(I)} half buried near ${named(P)}?`,
        never: ({ P }) => `Tell me about ${named(P)}.`,
        knowledge: ({ B }) => `${B}, how does the evening find you?`,
        unanswerable: ({ P }) => `Do you remember who played the silver violin at ${named(P)}?`,
        control: "Shall we walk a little further?",
    },
    ko: {
        needed: ({ A, B, P, I }) => `${A}${josa(A, "이가")} ${P}에서 ${B}에게 ${I}${josa(I, "을를")} 건넸던 거 기억나?`,
        promise: ({ A, B }) => `${A}${josa(A, "이가")} ${B}에게 무엇을 약속했는지 기억나?`,
        comparison: (hide, find) =>
            `${hide.A}${josa(hide.A, "이가")} ${hide.I}${josa(hide.I, "을를")} 어디에 숨겼고, 나중에 ${find.A}${josa(find.A, "이가")} ${find.I}${josa(find.I, "을를")} 어디서 찾아냈는지 기억나?`,
        retracted: ({ A, B, I }) =>
            `${A}${josa(A, "과와")} ${B}${josa(B, "이가")} ${I}${josa(I, "을를")} 두고 심하게 다투었던 거 기억나?`,
        stale: ({ A, P, I }) =>
            `${A}${josa(A, "이가")} ${P} 근처에서 반쯤 묻힌 ${I}${josa(I, "을를")} 찾아냈던 거 기억나?`,
        never: ({ P }) => `${P}에 대해 말해 줘.`,
        knowledge: ({ B }) => `${B}, 저녁은 어때?`,
        unanswerable: ({ P }) => `누가 ${P}에서 은빛 바이올린을 연주했는지 기억나?`,
        control: "조금 더 걸을까?",
    },
};

// ---------------------------------------------------------------------------------------------
// The plot

type Scene = { start: number; end: number; place: string; time: string; day: number; present: string[] };

/** The beats the probes need, placed by their share of the plot before the final two scenes. */
type Beat = "give" | "hideCmp" | "findCmp" | "argueRetract" | "findStale" | "findNever";

const BEAT_SHARES: [Beat, number][] = [
    ["give", 0.2],
    ["findNever", 0.3],
    ["hideCmp", 0.35],
    ["argueRetract", 0.45],
    ["findStale", 0.5],
    ["findCmp", 0.55],
];

/** Turns per scene; the final scene is `FINAL_SCENE_TURNS` long whatever the count. */
const SCENE_TURNS = 6;
/** The needed promise, then the neutral small talk. */
const FINAL_SCENE_TURNS = 4;

const AXES: Record<StoryKind, MemoryAxes> = {
    travel: { persistence: 1, change: 1, reach: 2 },
    give: { persistence: 2, change: 2, reach: 1 },
    hide: { persistence: 2, change: 1, reach: 1 },
    find: { persistence: 2, change: 2, reach: 1 },
    promise: { persistence: 2, change: 1, reach: 1 },
    resolve: { persistence: 2, change: 2, reach: 1 },
    argue: { persistence: 1, change: 2, reach: 2 },
    secret: { persistence: 3, change: 1, reach: 2 },
    chat: { persistence: 0, change: 0, reach: 1 },
    smallTalk: { persistence: 0, change: 0, reach: 1 },
};

const pad = (turn: number) => String(turn).padStart(4, "0");
export const userMessageId = (turn: number) => `t${pad(turn)}u`;
export const charMessageId = (turn: number) => `t${pad(turn)}c`;

/** The turn a message id names, or null for an id of another shape. */
export function turnOfMessageId(id: string): number | null {
    const match = /^t(\d{4})[uc]$/.exec(id);
    return match ? Number(match[1]) : null;
}

export const eventLabel = (turn: number) => `event:${turn}`;
export const pageLabel = (title: string) => `page:${title}`;
export const threadLabel = (title: string) => `thread:${title}`;

/** The beats' turns: distinct, in `BEAT_SHARES` order of placement, all before the final two scenes. */
function placeBeats(plotTurns: number): Map<number, Beat> {
    const taken = new Map<number, Beat>();
    for (const [beat, share] of BEAT_SHARES) {
        let turn = Math.min(plotTurns, Math.max(1, Math.floor(share * plotTurns) + 1));
        while (taken.has(turn)) {
            turn = turn >= plotTurns ? 1 : turn + 1;
        }
        taken.set(turn, beat);
    }
    return taken;
}

/** The scenes of a story of `turns` turns: blocks of `SCENE_TURNS`, then the final scene. */
function planScenes(turns: number, words: Words, random: Random, roles: Roles): Scene[] {
    const scenes: Scene[] = [];
    const finalStart = turns - FINAL_SCENE_TURNS + 1;
    let start = 1;
    let day = 0;
    let place = "";
    while (start < finalStart) {
        const end = Math.min(start + SCENE_TURNS - 1, finalStart - 1);
        scenes.push(makeScene(start, end));
        start = end + 1;
    }
    scenes.push(makeScene(finalStart, turns));
    // The last scene holds the secret's holder and the one kept out of it; the one before, the holder
    // and the one told. Each takes the forced members and a random rest.
    const before = scenes[scenes.length - 2];
    const final = scenes[scenes.length - 1];
    before.present = withForced([roles.holder, roles.told], before.present, words.cast, random);
    final.present = withForced([roles.holder, roles.unaware, roles.bystander], final.present, words.cast, random);
    return scenes;

    function makeScene(from: number, to: number): Scene {
        day++;
        const others = words.places.filter((candidate) => candidate !== place);
        place = random.pick(others);
        return {
            start: from,
            end: to,
            place,
            time: words.times[(day - 1) % words.times.length],
            day,
            present: random.sample(words.cast, 2 + random.int(3)),
        };
    }
}

/** `present` as a scene's attendance with `forced` in it, kept to at most four, in cast order. */
function withForced(forced: string[], present: string[], cast: readonly string[], random: Random): string[] {
    const rest = present.filter((name) => !forced.includes(name));
    const room = Math.max(0, 4 - forced.length);
    const chosen = new Set([...forced, ...random.sample(rest, Math.min(room, rest.length))]);
    return cast.filter((name) => chosen.has(name));
}

/** The four characters the knowledge probe and the final scene are built around. */
type Roles = { holder: string; told: string; unaware: string; bystander: string };

type Open = { title: string; A: string; B: string; opened: number };

/** The state the generator carries from turn to turn. */
type World = {
    held: Map<string, string>;
    open: Open[];
    secretsUsed: Set<string>;
    /** Every line a reply has held so far: no quoted line repeats across turns. */
    quoted: Set<string>;
};

export function generateStory(options: StoryOptions): Story {
    const { language, turns } = options;
    const seed = options.seed ?? 1;
    if (!Number.isInteger(turns) || turns < MIN_STORY_TURNS) {
        throw new Error(`A story needs at least ${MIN_STORY_TURNS} turns`);
    }
    const words = WORDS[language];
    const random = randomOf(prng(seed));
    const [holder, told, unaware, bystander] = random.sample(words.cast, 4);
    const roles: Roles = { holder, told, unaware, bystander };
    const scenes = planScenes(turns, words, random, roles);
    const finalScene = scenes[scenes.length - 1];
    const plotTurns = scenes[scenes.length - 2].end - 1;
    const beats = placeBeats(plotTurns);
    const world: World = { held: new Map(), open: [], secretsUsed: new Set(), quoted: new Set() };
    const probeItems = {
        give: words.items[0],
        compare: words.items[1],
        argue: words.items[2],
        stale: words.items[4],
        never: words.items[7],
        secret: words.items[3],
    };
    const neverPlace = words.places[5];
    const secretPlace = words.places[3];
    const beatSlots = new Map<Beat | "secret" | "promise", Slots>();
    const beatTurns = new Map<Beat | "secret" | "promise", number>();
    let compareHider: string | undefined;
    const script: TurnScript[] = [];

    for (let turn = 1; turn <= turns; turn++) {
        const scene = scenes.find(({ start, end }) => turn >= start && turn <= end)!;
        const beat = beats.get(turn);
        const base: Slots = { A: "", B: "", P: scene.place, I: "", T: scene.time, day: scene.day };
        let kind: StoryKind;
        let slots: Slots;
        if (turn === scenes[scenes.length - 2].end) {
            kind = "secret";
            slots = { ...base, A: roles.holder, B: roles.told, I: probeItems.secret, P: secretPlace };
            beatSlots.set("secret", slots);
            beatTurns.set("secret", turn);
        } else if (turn === finalScene.start) {
            kind = "promise";
            slots = { ...base, A: roles.holder, B: roles.unaware };
            beatSlots.set("promise", slots);
            beatTurns.set("promise", turn);
        } else if (turn > finalScene.start) {
            kind = "smallTalk";
            slots = base;
        } else if (beat) {
            const pair = random.sample(scene.present, 2);
            switch (beat) {
                case "give":
                    kind = "give";
                    slots = { ...base, A: pair[0], B: pair[1], I: probeItems.give };
                    break;
                case "hideCmp":
                    kind = "hide";
                    slots = { ...base, A: pair[0], I: probeItems.compare };
                    compareHider = pair[0];
                    break;
                case "findCmp": {
                    kind = "find";
                    const finder = scene.present.find((name) => name !== compareHider) ?? pair[0];
                    slots = { ...base, A: finder, I: probeItems.compare };
                    break;
                }
                case "argueRetract":
                    kind = "argue";
                    slots = { ...base, A: pair[0], B: pair[1], I: probeItems.argue };
                    break;
                case "findStale":
                    kind = "find";
                    slots = { ...base, A: pair[0], I: probeItems.stale };
                    break;
                case "findNever":
                    kind = "find";
                    slots = { ...base, A: pair[0], I: probeItems.never, P: neverPlace };
                    break;
            }
            beatSlots.set(beat, slots);
            beatTurns.set(beat, turn);
        } else if (turn === scene.start) {
            kind = "travel";
            const [A, B] = scene.present;
            slots = { ...base, A, B };
        } else {
            [kind, slots] = randomBeat(scene, base, world, words, random, turn, {
                secret: { I: probeItems.secret, P: secretPlace },
            });
        }
        script.push(turnOf(language, words, random, turn, kind, slots, scene, world));
    }

    const probes = buildProbes(
        language,
        words,
        script,
        { slots: beatSlots, turns: beatTurns },
        roles,
        probeItems,
        neverPlace,
    );
    return {
        language,
        seed,
        turns: script,
        cast: [...words.cast],
        places: [...words.places],
        items: [...words.items],
        names: { character: words.character, persona: words.persona, greeting: words.greeting },
        finalStage: finalScene.present,
        probes,
    };
}

/** A random beat for an ordinary turn, weighted toward gifts and kept promises. */
function randomBeat(
    scene: Scene,
    base: Slots,
    world: World,
    words: Words,
    random: Random,
    turn: number,
    reserved: { secret: { I: string; P: string } },
): [StoryKind, Slots] {
    const [A, B] = random.sample(scene.present, 2);
    const resolvable = world.open.filter((open) => open.opened <= turn - 3);
    const kinds: StoryKind[] = [
        "give",
        "give",
        "give",
        "hide",
        "find",
        "promise",
        "argue",
        "secret",
        "chat",
        "chat",
        ...(resolvable.length > 0 ? (["resolve", "resolve"] as const) : []),
    ];
    const kind = random.pick(kinds);
    const item = random.pick(words.items);
    switch (kind) {
        case "resolve": {
            const open = resolvable[0];
            return [kind, { ...base, A: open.A, B: open.B }];
        }
        case "secret": {
            // The probe's secret is the one record of its fact, so no other secret says the same.
            let I = item;
            let P = random.pick(words.places);
            if (I === reserved.secret.I && P === reserved.secret.P) {
                P = words.places[(words.places.indexOf(P) + 1) % words.places.length];
            }
            const key = `${I}|${P}`;
            if (world.secretsUsed.has(key)) {
                return ["chat", { ...base, A, B }];
            }
            return [kind, { ...base, A, B, I, P }];
        }
        case "give":
        case "argue":
            return [kind, { ...base, A, B, I: item }];
        case "hide":
        case "find":
            return [kind, { ...base, A, I: item }];
        default:
            return [kind, { ...base, A, B }];
    }
}

/** One turn's messages and scripted answers; `world` moves with it. */
function turnOf(
    language: StoryLanguage,
    words: Words,
    random: Random,
    turn: number,
    kind: StoryKind,
    slots: Slots,
    scene: Scene,
    world: World,
): TurnScript {
    const lines = LINES[language];
    const key = uniqueLine(
        language,
        kind === "smallTalk" ? random.pick(words.smallTalk).replace("{T}", slots.T) : KEY[language][kind](slots),
        world.quoted,
    );
    const details = DETAILS[language].map((detail) => detail(turn));
    for (const detail of details) {
        if (world.quoted.has(detail)) {
            throw new Error(`A quoted line repeats: ${detail}`);
        }
        world.quoted.add(detail);
    }
    const speaker = words.character;
    const participants = kind === "smallTalk" || kind === "travel" ? scene.present : [slots.A, slots.B].filter(Boolean);
    const analysis: AnalysisScript = {
        title: TITLE[language][kind](slots),
        summary: SUMMARY[language][kind](slots),
        participants: [...new Set(participants)],
        storyTime: { text: STORY_TIME[language](slots) },
        keyLines: [key, ...details].map((text) => ({ speaker, text })),
        stateChanges: [],
        knowledge: [],
        relationshipShifts: [],
        openThreads: { add: [], close: [] },
        axes: AXES[kind],
        pages: [],
        scene: {
            participants: scene.present,
            place: scene.place,
            time: STORY_TIME[language]({ ...slots, P: scene.place }),
            state: SCENE_STATE[language](scene.present, scene.place),
        },
    };
    const patches: PatchScript[] = [];
    const page = (title: string, type: MemoryPageType, ...sections: SectionScript[]) => {
        if (!analysis.pages.some((entry) => entry.title === title)) {
            analysis.pages.push({ title, type });
        }
        const found = patches.find((entry) => entry.title === title);
        if (found) {
            found.sections.push(...sections);
        } else {
            patches.push({ title, type, sections: [...sections] });
        }
    };
    const visit = () => page(slots.P, "location", { heading: "visits", op: "append", text: `${slots.day}: ${key}` });
    const { A, B, I, P } = slots;
    switch (kind) {
        case "travel":
            for (const name of scene.present) {
                page(name, "character", {
                    heading: "currentState",
                    op: "replace",
                    text: CURRENT_STATE[language](slots),
                });
            }
            visit();
            break;
        case "give":
            analysis.stateChanges.push({ pageId: B, section: "inventory", before: "", after: I, quote: key });
            page(A, "character", { heading: "inventory", op: "removeLine", text: I });
            page(B, "character", { heading: "inventory", op: "addLine", text: I });
            page(I, "item", { heading: "whereabouts", op: "replace", text: lines.heldBy(slots) });
            world.held.set(I, B);
            visit();
            break;
        case "hide":
            analysis.stateChanges.push({ pageId: I, section: "whereabouts", before: "", after: P, quote: key });
            analysis.knowledge.push({
                pageId: A,
                fact: lines.hidKnowledge(slots),
                stance: "knows",
                quote: key,
                knowers: [A],
            });
            page(A, "character", { heading: "knowledge", op: "append", text: lines.hidKnowledge(slots) });
            page(I, "item", { heading: "whereabouts", op: "replace", text: lines.hiddenAt(slots) });
            world.held.delete(I);
            visit();
            break;
        case "find":
            analysis.stateChanges.push({ pageId: A, section: "inventory", before: "", after: I, quote: key });
            page(A, "character", { heading: "inventory", op: "addLine", text: I });
            page(I, "item", { heading: "whereabouts", op: "replace", text: lines.foundNear(slots) });
            world.held.set(I, A);
            visit();
            break;
        case "promise": {
            const title = THREAD[language](slots);
            analysis.openThreads.add.push({ title, who: [A, B] });
            world.open.push({ title, A, B, opened: turn });
            page(A, "character", { heading: "goals", op: "append", text: lines.goal(slots) });
            visit();
            break;
        }
        case "resolve": {
            const index = world.open.findIndex((open) => open.A === A && open.B === B);
            const [open] = index === -1 ? [] : world.open.splice(index, 1);
            if (open) {
                analysis.openThreads.close.push(open.title);
            }
            analysis.relationshipShifts.push({ from: A, to: B, direction: "warmer", note: key });
            page(A, "character", { heading: "goals", op: "append", text: lines.kept(slots) });
            page(B, "character", { heading: "relationships", op: "append", text: lines.warmer({ ...slots, B: A }) });
            visit();
            break;
        }
        case "argue":
            analysis.relationshipShifts.push({ from: A, to: B, direction: "strained", note: key });
            page(A, "character", { heading: "relationships", op: "append", text: lines.strained(slots) });
            page(B, "character", { heading: "relationships", op: "append", text: lines.strained({ ...slots, B: A }) });
            page(I, "item", { heading: "notes", op: "append", text: lines.quarrelNote(slots) });
            break;
        case "secret": {
            const fact = FACT[language](slots);
            world.secretsUsed.add(`${I}|${P}`);
            for (const who of [A, B]) {
                analysis.knowledge.push({ pageId: who, fact, stance: "knows", quote: key, knowers: [A, B] });
            }
            page(A, "character", { heading: "knowledge", op: "append", text: lines.knowsSecret(slots) });
            page(B, "character", { heading: "knowledge", op: "append", text: lines.knowsSecret({ ...slots, B: A }) });
            page(I, "item", { heading: "whereabouts", op: "replace", text: lines.buried(slots) });
            break;
        }
        case "chat":
        case "smallTalk":
            break;
    }
    // A scene's first turn places everyone present, whatever its beat.
    if (turn === scene.start && kind !== "travel") {
        for (const name of scene.present) {
            page(name, "character", { heading: "currentState", op: "replace", text: CURRENT_STATE[language](slots) });
        }
    }
    // The reply: fillers around the key sentence and the two detail lines, every quoted line verbatim.
    const fillers = random.sample(words.fillers, 7 + random.int(5));
    const cut = (from: number, to: number) => fillers.slice(from, to);
    const reply = [...cut(0, 2), key, ...cut(2, 4), details[0], ...cut(4, 6), details[1], ...cut(6, fillers.length)];
    return {
        turn,
        userId: userMessageId(turn),
        charId: charMessageId(turn),
        user: random.pick(words.userLines),
        char: reply.join(" "),
        kind,
        analysis,
        patches,
    };
}

/** The probes of a generated story, one of each kind the design names, over the beats' turns. */
function buildProbes(
    language: StoryLanguage,
    words: Words,
    script: readonly TurnScript[],
    beats: {
        slots: ReadonlyMap<Beat | "secret" | "promise", Slots>;
        turns: ReadonlyMap<Beat | "secret" | "promise", number>;
    },
    roles: Roles,
    probeItems: Record<"give" | "compare" | "argue" | "stale" | "never" | "secret", string>,
    neverPlace: string,
): Probe[] {
    const queries = QUERIES[language];
    const at = (beat: Beat | "secret" | "promise") => {
        const turn = beats.turns.get(beat);
        const slots = beats.slots.get(beat);
        if (turn === undefined || slots === undefined) {
            throw new Error(`The story has no ${beat} beat`);
        }
        return { turn, slots, label: eventLabel(turn) };
    };
    const give = at("give");
    const hide = at("hideCmp");
    const find = at("findCmp");
    const argue = at("argueRetract");
    const stale = at("findStale");
    const secret = at("secret");
    const promise = at("promise");
    const staleEntry = script[stale.turn - 1];
    const flute = words.items[0].toLowerCase();
    const distractors = script
        .filter((entry) => entry.analysis.summary.toLowerCase().includes(flute))
        .map((entry) => eventLabel(entry.turn));
    return [
        {
            id: "needed-event",
            kind: "needed",
            query: queries.needed(give.slots),
            needed: [give.label, pageLabel(give.slots.A)],
            forbidden: [],
            distractors: [],
            mirrors: [give.label],
            note: `The gift of ${probeItems.give} at a fifth of the chat, and the giver's page, named in the query.`,
        },
        {
            id: "needed-thread",
            kind: "needed",
            query: queries.promise(promise.slots),
            needed: [threadLabel(THREAD[language](promise.slots)), pageLabel(promise.slots.B)],
            forbidden: [],
            distractors: [],
            mirrors: [promise.label],
            note: "The promise opened at the start of the final scene, whose parties are both on stage.",
        },
        {
            id: "comparison",
            kind: "comparison",
            query: queries.comparison(hide.slots, find.slots),
            needed: [hide.label, find.label],
            forbidden: [],
            distractors: [],
            mirrors: [hide.label, find.label],
            note: `Where ${probeItems.compare} was hidden and where it was found: two events, both needed.`,
        },
        {
            id: "retracted",
            kind: "mustNotLeak",
            query: queries.retracted(argue.slots),
            needed: [],
            forbidden: [argue.label],
            distractors: [],
            mirrors: [argue.label],
            setup: { kind: "retract", label: argue.label },
            note: "A quarrel retracted through the event repair: its event must stay out however well the query mirrors it.",
        },
        {
            id: "stale",
            kind: "mustNotLeak",
            query: queries.stale(stale.slots),
            needed: [],
            forbidden: [stale.label],
            distractors: [],
            mirrors: [stale.label],
            setup: {
                kind: "editMessage",
                messageId: staleEntry.charId,
                text: staleEntry.char
                    .replace(staleEntry.analysis.keyLines[0].text, "")
                    .replace(/\s{2,}/g, " ")
                    .trim(),
            },
            note: "A find whose reply was edited after recording: reconciliation reads the event stale, so it must stay out.",
        },
        {
            id: "never",
            kind: "mustNotLeak",
            query: queries.never({ ...stale.slots, P: neverPlace }),
            needed: [],
            forbidden: [pageLabel(neverPlace)],
            distractors: [],
            mirrors: [pageLabel(neverPlace)],
            setup: { kind: "never", label: pageLabel(neverPlace) },
            note: `The ${neverPlace} page set to never: named in the query, it must stay out.`,
        },
        {
            id: "knowledge",
            kind: "knowledge",
            query: queries.knowledge({ ...secret.slots, B: roles.unaware }),
            needed: [pageLabel(roles.unaware)],
            forbidden: [],
            distractors: [],
            boundary: { page: pageLabel(roles.unaware), fact: FACT[language](secret.slots) },
            mirrors: [],
            note: `${roles.holder} told ${roles.told} a secret; ${roles.unaware} is on stage and must be listed as not knowing it.`,
        },
        {
            id: "unanswerable",
            kind: "unanswerable",
            query: queries.unanswerable(give.slots),
            needed: [],
            forbidden: [],
            distractors,
            mirrors: [],
            note: `Nobody played a silver violin; the ${probeItems.give} events share a word with the query.`,
        },
        {
            id: "control",
            kind: "unanswerable",
            query: queries.control,
            needed: [],
            forbidden: [],
            distractors: [],
            mirrors: [],
            note: "A query that repeats nothing: how much the lanes select on their own.",
        },
    ];
}

/** The chat's messages in store order, user then reply per turn. */
export function storyMessages(story: Story): { chatId: string; role: "user" | "char"; data: string }[] {
    return story.turns.flatMap(({ userId, charId, user, char }) => [
        { chatId: userId, role: "user" as const, data: user },
        { chatId: charId, role: "char" as const, data: char },
    ]);
}

/** What the generated data comes to: its messages, their UTF-8 bytes, and the story as JSON. */
export function storySizes(story: Story): { messages: number; messageBytes: number; jsonBytes: number } {
    const messages = storyMessages(story);
    return {
        messages: messages.length,
        messageBytes: messages.reduce((sum, { data }) => sum + Buffer.byteLength(data, "utf8"), 0),
        jsonBytes: Buffer.byteLength(JSON.stringify(story), "utf8"),
    };
}

/** The page type a title names in a story: a cast member, a place, or an item. */
export function pageTypeOf(story: Pick<Story, "cast" | "places" | "items">, title: string): MemoryPageType {
    if (story.cast.includes(title)) {
        return "character";
    }
    if (story.places.includes(title)) {
        return "location";
    }
    if (story.items.includes(title)) {
        return "item";
    }
    throw new Error(`No page type for ${title}`);
}
