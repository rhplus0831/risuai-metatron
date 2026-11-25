/**
 * The overrides of a large module's mock factory. A name must be an export of the module, so a
 * renamed export fails `pnpm check` at every file that passes it, and a function stays a function.
 * Its signature is free: a test's stub answers with the part of a chat or a response the code under
 * test reads, and the factory's own defaults are what `satisfies` the module's type.
 */
export type ModuleMockOverrides<Module> = {
    [Name in keyof Module]?: Module[Name] extends abstract new (...args: never[]) => unknown
        ? abstract new (...args: never[]) => unknown
        : Module[Name] extends (...args: never[]) => unknown
          ? (...args: never[]) => unknown
          : Module[Name];
};
