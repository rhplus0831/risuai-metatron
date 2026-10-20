/**
 * The synthetic upstream `Database` that `database-v8.risudat` encodes (see `README.md`). Every value
 * is made up for the test: no user data, no real key.
 */
export const UPSTREAM_FIXTURE_DATABASE = {
    formatversion: 5,
    account: undefined,
    characters: [
        {
            type: "character",
            chaId: "0f8e3c4a-5b6d-4e7f-8a9b-0c1d2e3f4a5b",
            name: "테스트 캐릭터 🌸",
            firstMessage: "안녕하세요, {{user}}! こんにちは。",
            desc: "A made-up character for the codec fixture.",
            image: "assets/3f2a9c.png",
            chatPage: 0,
            emotionImages: [["joy", "assets/joy.png"]],
            bias: [],
            viewScreen: "none",
            globalLore: [
                {
                    key: "dragon",
                    secondkey: "",
                    insertorder: 100,
                    comment: "용",
                    content: "드래곤은 날 수 있다.",
                    mode: "normal",
                    alwaysActive: false,
                    selective: false,
                },
            ],
            coldstorage: undefined,
            chats: [
                {
                    id: "6c1b2a3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
                    name: "Chat 1",
                    note: "",
                    localLore: [],
                    fmIndex: -1,
                    message: [
                        { role: "char", data: "첫 인사입니다.", saying: "", time: 1792467896818 },
                        {
                            role: "user",
                            data: "Hello there",
                            chatId: "8d7c6b5a-4f3e-4d2c-9b1a-0f9e8d7c6b5a",
                            time: undefined,
                        },
                    ],
                },
            ],
        },
        {
            type: "group",
            chaId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
            name: "Group of one",
            characters: ["0f8e3c4a-5b6d-4e7f-8a9b-0c1d2e3f4a5b"],
            characterTalks: [1],
            characterActive: [true],
            autoMode: false,
            useCharacterLore: true,
            chats: [
                {
                    id: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
                    name: "Group chat",
                    note: "",
                    localLore: [],
                    message: [{ role: "char", data: "…", saying: "0f8e3c4a-5b6d-4e7f-8a9b-0c1d2e3f4a5b" }],
                },
            ],
        },
    ],
    botPresets: [
        {
            name: "Default",
            mainPrompt: "You are {{char}}.",
            temperature: 80,
            maxContext: 16000,
            maxResponse: 500,
            frequencyPenalty: 70,
            PresensePenalty: 70,
        },
    ],
    botPresetsId: 0,
    personas: [{ name: "User", personaPrompt: "", icon: "" }],
    selectedPersona: 0,
    openAIKey: "sk-fixture-not-a-real-key",
    hotkeys: [],
    pluginCustomStorage: {},
    lastBackup: 4294967296001,
    negativeOffset: -5000000000,
    ratio: 0.75,
    nothing: null,
};
