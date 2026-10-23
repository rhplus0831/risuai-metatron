# Start Here

- Use `pnpm`.
- Read `STRUCTURE.md` next: its Agent Read Protocol and Repository-Wide
  Invariants, then the one focused guide its Choose By Task table routes you to.
  Do not load every guide.

# Search Hygiene

- The root `.ignore` file hides only tokenizer data and rarely used
  static/vendor payloads (listed under "Search-excluded payloads" in
  `STRUCTURE.md`) from broad file and text searches.
- Plain `rg` is enough for reference checks such as "is X still used
  anywhere?". Do not add a `git grep` pass just because `.ignore` hides some
  tracked files.
- For initial file-name searches, prefer `rg --files | rg "<name>"` or
  `fd <name>` so `.ignore` is honored. Use a targeted path, or the command
  below, only when intentionally inspecting ignored payloads (for example the
  vendored `src/ts/rpack/` code).
- To search the ignored payloads, use `--no-ignore-dot` and always exclude the
  tokenizers, which otherwise flood the results:
  `rg --no-ignore-dot -g '!server/assets/token/' <pattern>`.
  `--no-ignore-dot` drops `.ignore` but keeps `.gitignore`, so `node_modules/`
  and `dist/` stay out. Do not use plain `--no-ignore` for this.
- Avoid broad `rg --files -g "*<name>*"` searches because explicit include globs
  can re-include ignored payloads.

# Collaboration Guideline

- When writing commit titles, use conventional prefixes such as `feat(llm):`, `fix(cbs):`, and `refactor(server):`.
- Describe what you did in the commit message.
