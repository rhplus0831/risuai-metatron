# Start Here

- Use `pnpm`.
- Read `STRUCTURE.md` next: its Agent Read Protocol and Repository-Wide
  Invariants, then the one focused guide its Choose By Task table routes you to.
  Do not load every guide.

# Search Hygiene

- The root `.ignore` file excludes tracked static/vendor payloads from broad
  file and text searches.
- For initial file-name searches, prefer `rg --files | rg "<name>"` or
  `fd <name>` so `.ignore` is honored. Use `--no-ignore` or a targeted path
  only when intentionally inspecting ignored payloads.
- Avoid broad `rg --files -g "*<name>*"` searches because explicit include globs
  can re-include ignored payloads.

# Collaboration Guideline

- When writing commit titles, use conventional prefixes such as `feat(risu):`, `fix(ai):`, and `refactor(metatron):`.
- Describe what you did in the commit message.