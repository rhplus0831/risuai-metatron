import { globalFetch } from "../globalApi.svelte";
import { sleep } from "../util";

interface HordeModel {
    performance: number;
    queued: number;
    jobs: number;
    eta: number;
    type: "text";
    name: "aphrodite\/Undi95\/Toppy-M-7B";
    count: number;
}

let modelList: HordeModel[] | "loading" = null;

//until horde is ready
// modelList = []

export async function getHordeModels(): Promise<HordeModel[]> {
    if (modelList === null) {
        try {
            modelList = "loading";
            const models = await globalFetch("https://stablehorde.net/api/v2/status/models?type=text", {
                method: "GET",
            });
            if (!models.ok) {
                throw new Error(`Horde models: HTTP ${models.status}`);
            }
            modelList = models.data;
            return models.data;
        } catch (error) {
            modelList = null;
            return [];
        }
    } else if (modelList === "loading") {
        while (true) {
            if (modelList !== "loading") {
                return getHordeModels();
            }
            await sleep(10);
        }
    } else {
        return modelList;
    }
}
