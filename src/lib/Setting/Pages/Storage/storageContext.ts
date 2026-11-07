import { createContext } from "svelte";
import type { StorageController } from "./storageController.svelte";

/** One controller owned by StorageSettings and shared by its mounted sections. */
export const [getStorageController, setStorageController] = createContext<StorageController>();
