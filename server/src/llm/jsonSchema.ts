// Port of `src/ts/process/templates/jsonSchema.ts`. The client parses CBS with `risuChatParser`
// (no chat target: the tab's chat); here `parseCbs` asks the client's tab, so the helpers that
// parse are async.
import type { RequestContext } from "./context.ts";
import { jsonOutputTrimmer } from "./util.ts";

type SchemaContext = Pick<RequestContext, "db" | "parseCbs">;

export async function convertInterfaceToSchema(int: string, ctx: SchemaContext) {
    if (!int.startsWith("interface ") && !int.startsWith("export interface ")) {
        return JSON.parse(int);
    }

    int = await ctx.parseCbs(int);

    type SchemaProp = {
        type: "array" | "string" | "number" | "boolean";
        items?: SchemaProp;
        enum?: string[];
        const?: string;
    };

    const lines = int.split("\n");
    let schema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties: {} as { [key: string]: SchemaProp },
        required: [] as string[],
    };
    for (let i = 1; i < lines.length; i++) {
        let content = lines[i].trim();
        if (content === "{") {
            continue;
        }
        if (content === "}") {
            continue;
        }
        if (content === "") {
            continue;
        }

        let placeHolders: string[] = [];

        content = content
            .replace(/\\"/gu, "\uE9b4a")
            .replace(/\\'/gu, "\uE9b4b")
            .replace(/"(.+?)"/gu, function (match, p1) {
                placeHolders.push(match);
                return `\uE9b4d${placeHolders.length - 1}`;
            })
            .replace(/'(.+?)'/gu, function (match, p1) {
                placeHolders.push(`"${p1}"`);
                return `\uE9b4d${placeHolders.length - 1}`;
            })

            .split("//")[0]
            .trim() //remove comments

            .replace(/((number)|(string)|(boolean))\[\]/gu, "Array<$1>");

        if (content.endsWith(",") || content.endsWith(";")) {
            content = content.slice(0, -1);
        }

        let spData = content.replace(/ /g, "").split(":");

        if (spData.length !== 2) {
            throw "SyntaxError Found";
        }

        let [property, typeData] = spData;

        switch (typeData) {
            case "string":
            case "number":
            case "boolean": {
                schema.properties[property] = {
                    type: typeData,
                };
                break;
            }
            case "Array<string>":
            case "Array<number>":
            case "Array<boolean>": {
                const ogType = typeData.slice(6, -1);

                schema.properties[property] = {
                    type: "array",
                    items: {
                        type: ogType as "string" | "number" | "boolean",
                    },
                };
                break;
            }
            default: {
                const types = typeData.split("|");
                const strings: string[] = [];
                for (const t of types) {
                    if (!t.startsWith("\uE9b4d")) {
                        throw "Unsupported Type Detected";
                    }
                    const textIndex = t.replace("\uE9b4d", "");
                    const text = placeHolders[parseInt(textIndex)];
                    const textParsed = JSON.parse(text.replace(/\uE9b4a/gu, '\\"').replace(/\uE9b4b/gu, "\\'"));
                    strings.push(textParsed);
                }
                if (strings.length === 1) {
                    schema.properties[property] = {
                        type: "string",
                        const: strings[0],
                    };
                } else {
                    schema.properties[property] = {
                        type: "string",
                        enum: strings,
                    };
                }
            }
        }

        schema.required.push(property);
    }
    return schema;
}

export async function getOpenAIJSONSchema(ctx: SchemaContext, schema?: string) {
    const db = ctx.db;
    return {
        name: "format",
        strict: db.strictJsonSchema,
        schema: await convertInterfaceToSchema(schema ?? db.jsonSchema, ctx),
    };
}

export async function getGeneralJSONSchema(ctx: SchemaContext, schema?: string, excludes: string[] = []) {
    const db = ctx.db;

    function process(data: any) {
        const keys = Object.keys(data);
        for (const key of keys) {
            if (excludes.includes(key)) {
                delete data[key];
            }
            if (typeof data[key] === "object") {
                data[key] = process(data[key]);
            }
        }
        return data;
    }

    const d = await convertInterfaceToSchema(schema ?? db.jsonSchema, ctx);
    return process(d);
}

export async function extractJSON(data: any, format: string, ctx: SchemaContext): Promise<any> {
    const extract = async (data: any, format: string): Promise<any> => {
        try {
            if (data === undefined || data === null) {
                return "";
            }

            const fp = format.split(".");
            const current = data[fp[0]];

            if (current === undefined) {
                return "";
            } else if (fp.length === 1) {
                return `${current ?? ""}`;
            } else if (typeof current === "object") {
                return await extractJSON(current, fp.slice(1).join("."), ctx);
            } else if (Array.isArray(current)) {
                const index = parseInt(fp[1]);
                return await extractJSON(current[index], fp.slice(1).join("."), ctx);
            } else {
                return `${current ?? ""}`;
            }
        } catch (error) {
            return "";
        }
    };
    try {
        format = await ctx.parseCbs(format);
        data = data.trim();
        if (data.startsWith("{")) {
            return await extract(JSON.parse(jsonOutputTrimmer(data)), format);
        }
    } catch (error) {}
    return data;
}
