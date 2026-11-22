# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hyrenk722/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hyrenk722/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Built for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) ($100 in USDC).

`mend` applies patches written in any of the edit formats AI tools emit, safely and
deterministically. Give it a patch on stdin or from a file; it edits the files in
the current directory tree, or reports exactly why it cannot.

## Formats

- **Unified diffs** (`diff --git`, `---`/`+++`, `@@` hunks) — create, delete, rename
  and edit files, including moves reported as `R old -> new`.
- **SEARCH/REPLACE blocks** (`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`).
- **V4A patches** (`*** Begin Patch` … `*** End Patch`, with `*** Add File`,
  `*** Delete File`, `*** Update File` sections, anchors and `*** End of File`).
- **JSON edits** (a JSON array or JSON Lines of edit objects: `create`,
  `str_replace`, `insert`).

## Matching

Old text is matched in three tiers: exact, then ignoring trailing whitespace, then
ignoring leading and trailing whitespace (with re-indentation). `--strict` allows
only exact matches. A patch that matches ambiguously, or not at all, fails that
edit without touching any file: edits apply atomically — if any edit fails, no
file is written.

## Usage

```sh
node main.ts [options] [PATCH]
```

- `PATCH` is a file, or `-`/omitted to read from stdin.
- `--format <auto|unified|search-replace|v4a|json>` — default `auto` (detected).
- `--strict` — exact matches only.
- `--check` — report what would change, without changing anything.
- `--` ends option parsing.

Exit code `0` on success (`ok: N files`), `1` when edits fail, `2` for usage,
format or parse errors.

## Requirements

Node.js 22, standard library only — no dependencies, no install step.

## License

MIT. See `LICENSE`.
