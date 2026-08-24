# Repository Guidelines

## Project Structure & Module Organization
- `src/`: TypeScript sources. Dual‑mode (`rollback`/`ledger`) core state machine in `main.ts` (typed errors via `lite-fp`), public exports in `index.ts`, side‑effect orchestrator in `orchestrator.ts`, hash‑chained log/snapshots/locks in `layer2.ts`, pure SHA‑256/512 in `hash.ts`, pluggable seams (Clock/Hasher/Serializer) in `adapters.ts`, durable JSONL effect store in `file_store.ts`.
- `test/`: Lightweight TS test files (e.g., `main.test.ts`) sharing the harness in `test_utils.ts`.
- `examples/`: Runnable demos (e.g., `examples/layer2_example.ts`).
- `bench/`: Microbenchmarks and usage demos (e.g., `bench/main.ts`).
- `dist/`: Build output (JS and `.d.ts`). Do not edit by hand.

## Build, Test, and Development Commands
- `npm run build`: Clean `dist/` and compile TypeScript with declarations.
- `npm run clean`: Remove `dist/` using `rimraf`.
- `npm test`: Run all suites (`test:main`, `test:orchestrator`, `test:layer2`, `test:seams`, `test:backlog`) sequentially.
- `npm run test:main` / `test:orchestrator` / `test:layer2` / `test:seams` / `test:backlog`: Run a single suite via `ts-node` (CommonJS override).
- Example (ad‑hoc): `npx ts-node --compiler-options '{"module":"CommonJS"}' bench/main.ts`.

## Coding Style & Naming Conventions
- Language: TypeScript, `strict` mode enabled, ES2022 modules in `src/`.
- Purity: Keep `src/main.ts` and exported API pure/deterministic (no I/O, timers, globals). Handle side effects in `orchestrator.ts` or external drivers.
- Naming: Types/interfaces `PascalCase` (e.g., `Time`, `Tick`); exported functions use `snake_case` (e.g., `new_mach`, `time_to_tick`); variables `camelCase`; test files `*.test.ts`.
- Formatting/Linting: No enforced formatter in repo; follow existing style (2‑space indent, readable diffs). Keep files small and focused.

## Testing Guidelines
- Framework: Shared harness in `test/test_utils.ts` (custom `describe/it/assert`, async‑aware; each spec ends with `run_all_tests()`).
- Scope: Prefer unit tests for pure functions; avoid nondeterminism.
- Naming: One spec per module (e.g., `orchestrator.test.ts`).
- Run: `npm test` (all suites) or a single `npm run test:<suite>`. Add new tests under `test/`.

## Commit & Pull Request Guidelines
- Commits: Use Conventional Commits where possible: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`. Keep messages imperative and scoped (e.g., `feat: add get_State export`).
- PRs: Include a clear summary, rationale, and links to issues. Note API changes and update `README.md` if behavior or types change. Add/adjust tests and, when relevant, include quick bench results from `bench/`.

## Architecture Notes
- Core loop: `new_mach` → `register_action`/`run` → `compute`. Ticks derive from time via `time_to_tick` (inverse: `tick_to_time`).
- Orchestration: Generate and execute side effects outside the pure core; keep idempotency caches in the driver layer.
- Layer2: append‑only log + snapshots chained with SHA‑256/512 (`hash.ts`); replays rebuild state from a snapshot by re‑applying logged actions through the core machine.
