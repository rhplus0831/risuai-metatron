import type { Database } from "src/ts/storage/database.svelte";

/**
 * The oracle's whole-database read: the pre-cutover client code read `getDatabase()` from
 * `database.svelte`, which the client no longer has (Phase 6 slice 10). A parity test installs the
 * flat object its oracle reads (`setOracleDatabase`), the same object it feeds the client's records.
 */
let read: () => Database = () => {
    throw new Error("the oracle database is not installed (setOracleDatabase)");
};

export function setOracleDatabase(reader: () => Database) {
    read = reader;
}

export function getDatabase(): Database {
    return read();
}
