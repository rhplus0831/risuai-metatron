import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { pluginHooks } from "src/ts/plugins/pluginHooks";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { requestChatData } from "../request";
import { requestServer } from "../transport";

vi.mock("../transport", () => ({ requestServer: vi.fn() }));

const attempt = vi.mocked(requestServer);
const translate = () => requestChatData({ formated: [], bias: {}, tools: [] }, "translate");

beforeEach(() => {
    installFlatDatabase({ aiModel: "echo_model", minResponseLengthTranslate: 4, requestRetrys: 1 });
    attempt.mockReset().mockRejectedValue(new Error("Unexpected extra request"));
});

it("retries a short translation after replacement and returns the complete second answer", async () => {
    const removePrefix = (text: string) => text.replace("Translation: ", "");
    pluginHooks.replacerafterRequest.add(removePrefix);
    onTestFinished(() => {
        pluginHooks.replacerafterRequest.delete(removePrefix);
    });
    attempt.mockResolvedValueOnce({ type: "success", result: "Translation: No." });
    attempt.mockResolvedValueOnce({ type: "success", result: "Translation:  done " });

    expect(await translate()).toEqual({ type: "success", result: " done " });
    expect(attempt).toHaveBeenCalledTimes(2);
});

it("returns the last length rejection when the tab spends its retry", async () => {
    attempt.mockResolvedValueOnce({ type: "success", result: "" });
    attempt.mockResolvedValueOnce({ type: "success", result: "🙂" });

    expect(await translate()).toEqual({
        type: "fail",
        result: "The model's answer was shorter than the minimum (1 < 4)",
    });
    expect(attempt).toHaveBeenCalledTimes(2);
});
