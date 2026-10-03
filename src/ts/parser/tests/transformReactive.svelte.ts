// Test-only reactive source for `transformClient.test.ts`: the mocked chat module's lock reader reads
// it, as the real `isMessageLocked` reads `lockState.version`, so a test can tell whether a `$derived`
// over `captureTransform` depends on the lock state.
export const lockSource = $state({ version: 0 });
