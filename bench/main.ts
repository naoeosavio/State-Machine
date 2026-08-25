import {
  new_mach,
  run,
  compute,
  register_action,
  fast_forward,
  type MachMode,
} from "../src/main";

// ---------------------------------------------------------------------------
// Harness: adaptive iteration counts, JIT warmup, median of N samples.
// Sequential scenarios carry a >= 1M op/s target and print PASS/FAIL.
// This script ALWAYS exits with code 0 — it reports, it does not gate CI.
// ---------------------------------------------------------------------------

type MyState = { count: number };
type MyAction = { type: "add"; time: number; value: number };

const game = {
  init: (): MyState => ({ count: 0 }),
  when: (action: MyAction, state: MyState): MyState =>
    action.type === "add" ? { count: state.count + action.value } : state,
  tick: (state: MyState): MyState => state,
};

const TARGET_OPS = 1_000_000;

type Sample = { ops_per_sec: number; runs: number; ms: number };

function measure(fn: () => void, min_ms: number): Sample {
  // Grow the batch until it runs for at least min_ms (or a sane cap).
  let count = 1;
  let elapsed = 0;
  for (;;) {
    const t0 = performance.now();
    for (let i = 0; i < count; ++i) fn();
    elapsed = performance.now() - t0;
    if (elapsed >= min_ms || count >= 2 ** 30) break;
    count =
      elapsed < 1
        ? count * 16
        : Math.min(2 ** 30, Math.ceil((count * min_ms * 1.2) / elapsed));
  }
  return { ops_per_sec: (count / elapsed) * 1000, runs: count, ms: elapsed };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

let pass_count = 0;
let fail_count = 0;
const summary_rows: { name: string, rate: number, unit: string, targeted: boolean }[] = [];

async function bench(
  name: string,
  fn: () => void,
  opts?: { samples?: number, unit?: string, inner_ops?: number, target?: number },
) {
  const samples = opts?.samples ?? 3;
  const unit = opts?.unit ?? "op";
  const inner_ops = opts?.inner_ops ?? 1;

  // Warmup (JIT + inline caches), untimed result discarded.
  measure(fn, 20);

  const rates: number[] = [];
  let last_runs = 0;
  let last_ms = 0;
  for (let i = 0; i < samples; ++i) {
    const s = measure(fn, 80);
    rates.push(s.ops_per_sec * inner_ops);
    last_runs = s.runs * inner_ops;
    last_ms = s.ms;
  }

  const ops_per_sec = median(rates);
  const target = opts?.target;
  const verdict = target === undefined ? "" : ops_per_sec >= target ? " \x1b[32m[PASS]\x1b[0m" : " \x1b[31m[FAIL]\x1b[0m";
  if (target !== undefined) {
    ops_per_sec >= target ? ++pass_count : ++fail_count;
  }
  summary_rows.push({ name, rate: ops_per_sec, unit, targeted: target !== undefined });

  console.log(
    `  ${name.padEnd(34)} ${fmt(ops_per_sec).padStart(14)} ${unit}/s` +
    `  (${last_ms.toFixed(1)}ms / ${fmt(last_runs)} ${unit}s)` +
    verdict,
  );
}

function new_game_mach(mode: MachMode, opts?: { autocommit_ticks?: number }) {
  return new_mach<MyState, MyAction>(game, 60, 10_000_000, { mode, ...opts });
}

async function main() {
  console.log("Running benchmarks...\n");

  // --- [run] sequential: register + compute in one call --------------------
  console.log("[run · sequential]");
  for (const mode of ["rollback", "ledger"] as const) {
    const mach = new_game_mach(mode);
    let time = 0;
    await bench(`run (${mode})`, () => {
      run(mach, game, { time: (time += 16), type: "add", value: 1 });
    }, { target: TARGET_OPS });
  }

  // --- [register_action + compute] sequential ------------------------------
  console.log("\n[register_action + compute · sequential]");
  for (const mode of ["rollback", "ledger"] as const) {
    const mach = new_game_mach(mode);
    let time = 0;
    await bench(`compute (${mode})`, () => {
      register_action(mach, { time: (time += 16), type: "add", value: 1 });
      compute(mach, game, time);
    }, { target: TARGET_OPS });
  }

  // --- [retention] autocommit keeps history bounded ------------------------
  console.log("\n[retention · auto-commit policy] (informational)");
  {
    const mach = new_game_mach("rollback", { autocommit_ticks: 1024 });
    let time = 0;
    await bench("run (rollback, autocommit=1024)", () => {
      run(mach, game, { time: (time += 16), type: "add", value: 1 });
    }, { unit: "op" });
  }

  // --- [ledger rejection] late action fast-fail ----------------------------
  console.log("\n[ledger · late-action guard]");
  {
    const mach = new_game_mach("ledger");
    run(mach, game, { time: 60_000_000, type: "add", value: 1 }); // head far ahead
    await bench("register_action (ACTION_IN_PAST)", () => {
      register_action(mach, { time: 16, type: "add", value: 1 }); // always rejected
    });
  }

  // --- [rollback] out-of-order recompute -----------------------------------
  console.log("\n[rollback · out-of-order]");
  {
    const SPAN = 100;
    const inner_ops = SPAN + 1;
    await bench("run (out-of-order, span 100)", () => {
      const mach = new_mach<MyState, MyAction>(game, 60, 100_000);
      for (let i = 1; i <= SPAN; ++i) {
        run(mach, game, { time: i * 16, type: "add", value: 1 });
      }
      run(mach, game, { time: 50 * 16, type: "add", value: 1 }); // late => recompute
    }, { samples: 3, inner_ops, unit: "run" });
  }

  // --- [fast_forward] pure backtest probe ----------------------------------
  console.log("\n[fast_forward · backtest probe]");
  {
    const TICKS = 100_000;
    const ff_base = new_mach<MyState, MyAction>(game, 60, 10_000_000);
    register_action(ff_base, { time: 16, type: "add", value: 1 });
    compute(ff_base, game, 16);
    await bench(`fast_forward (+${TICKS / 1000 | 0}k ticks)`, () => {
      fast_forward(ff_base, game, 16 + TICKS * 16);
    }, { samples: 5, inner_ops: TICKS, unit: "tick" });
  }

  // --- summary -------------------------------------------------------------
  console.log("\nSummary (sequential targets >= " + fmt(TARGET_OPS) + " op/s)");
  const targeted = summary_rows.filter((r) => r.targeted);
  for (const row of targeted) {
    console.log(`  ${row.rate >= TARGET_OPS ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${row.name.padEnd(34)} ${fmt(row.rate).padStart(14)} ${row.unit}/s`);
  }
  console.log(
    `\n  ${pass_count} passed, ${fail_count} failed (of ${targeted.length} targeted scenarios).`,
  );
  console.log("...done.");
}

main().catch(console.error);
