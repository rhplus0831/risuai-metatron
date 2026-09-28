// Settings shapes persisted in the database, presets, and characters.

export interface NAISettings {
    topK: number;
    topP: number;
    topA: number;
    tailFreeSampling: number;
    repetitionPenalty: number;
    repetitionPenaltyRange: number;
    repetitionPenaltySlope: number;
    repostitionPenaltyPresence: number;
    seperator: string;
    frequencyPenalty: number;
    presencePenalty: number;
    typicalp: number;
    starter: string;
    mirostat_lr?: number;
    mirostat_tau?: number;
    cfg_scale?: number;
}

export interface ColorScheme {
    bgcolor: string;
    darkbg: string;
    borderc: string;
    selected: string;
    draculared: string;
    textcolor: string;
    textcolor2: string;
    darkBorderc: string;
    darkbutton: string;
    type: "light" | "dark";
}

export interface OobaChatCompletionRequestParams {
    mode: "instruct" | "chat" | "chat-instruct";
    turn_template?: string;
    name1_instruct?: string;
    name2_instruct?: string;
    context_instruct?: string;
    system_message?: string;
    name1?: string;
    name2?: string;
    context?: string;
    greeting?: string;
    chat_instruct_command?: string;
    preset?: string; // The '?' denotes that the property is optional
    tokenizer?: string;
    min_p?: number;
    top_k?: number;
    repetition_penalty?: number;
    repetition_penalty_range?: number;
    typical_p?: number;
    tfs?: number;
    top_a?: number;
    epsilon_cutoff?: number;
    eta_cutoff?: number;
    guidance_scale?: number;
    negative_prompt?: string;
    penalty_alpha?: number;
    mirostat_mode?: number;
    mirostat_tau?: number;
    mirostat_eta?: number;
    temperature_last?: boolean;
    do_sample?: boolean;
    seed?: number;
    encoder_repetition_penalty?: number;
    no_repeat_ngram_size?: number;
    min_length?: number;
    num_beams?: number;
    length_penalty?: number;
    early_stopping?: boolean;
    truncation_length?: number;
    max_tokens_second?: number;
    custom_token_bans?: string;
    auto_max_new_tokens?: boolean;
    ban_eos_token?: boolean;
    add_bos_token?: boolean;
    skip_special_tokens?: boolean;
    grammar_string?: string;
}

export interface TranslatorPreset {
    name: string;
    prompt: string;
    maxResponse: number;
}

export interface OnnxModelFiles {
    files: { [key: string]: string };
    id: string;
    name?: string;
}

export interface Hotkey {
    key: string;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    action: string;
}
