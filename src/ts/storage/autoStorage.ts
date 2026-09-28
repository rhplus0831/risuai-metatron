import { NodeStorage } from "./nodeStorage";

export class AutoStorage {
    realStorage: NodeStorage;

    async setItem(key: string, value: Uint8Array): Promise<void> {
        await this.Init();
        await this.realStorage.setItem(key, value);
    }
    async getItem(key: string): Promise<Buffer> {
        await this.Init();
        return await this.realStorage.getItem(key);
    }
    async keys(): Promise<string[]> {
        await this.Init();
        return await this.realStorage.keys();
    }
    async removeItem(key: string) {
        await this.Init();
        return await this.realStorage.removeItem(key);
    }

    async Init() {
        if (!this.realStorage) {
            console.log("using node storage");
            this.realStorage = new NodeStorage();
        }
    }

    listItem = this.keys;
}
