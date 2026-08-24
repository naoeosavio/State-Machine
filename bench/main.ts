import { new_mach, run, compute, register_action, fast_forward } from "../src/main";

type MyState = { count: number };
type MyAction = { type: "add"; time: number; value: number };

const game = {
  init: (): MyState => ({ count: 0 }),
  when: (action: MyAction, state: MyState): MyState =>
    action.type === "add" ? { count: state.count + action.value } : state,
  tick: (state: MyState): MyState => state,
};

async function bench(name: string, fn: () => void, count: number = 100) {
  const start = performance.now();
  for (let i = 0; i < count; ++i) fn();
  const time = performance.now() - start;
  console.log(`${name.padEnd(28)} ${Math.round(count / time * 1000).toLocaleString("en-US")} op/s (${time.toFixed(1)}ms / ${count} runs)`);
}

async function main() {
  console.log("Running benchmarks...\n");

  const N = 2000;

  console.log("[run]");
  const run_mach = new_mach<MyState, MyAction>(game, 60, 10000);
  let run_time = 0;
  await bench("run (sequential)", () => {
    run(run_mach, game, { time: (run_time += 16), type: "add", value: 1 });
  }, N);

  console.log("\n[register_action + compute]");
  const comp_mach = new_mach<MyState, MyAction>(game, 60, 10000);
  let comp_time = 0;
  await bench("compute (sequential)", () => {
    register_action(comp_mach, { time: (comp_time += 16), type: "add", value: 1 });
    compute(comp_mach, game, comp_time);
  }, N);

  console.log("\n[rollback]");
  await bench("run (out-of-order, span 100)", () => {
    const mach = new_mach<MyState, MyAction>(game, 60, 100000);
    for (let i = 1; i <= 100; ++i) {
      run(mach, game, { time: i * 16, type: "add", value: 1 });
    }
    run(mach, game, { time: 50 * 16, type: "add", value: 1 }); // late => recompute
  }, 200);

  console.log("\n[fast_forward (backtest probe)]");
  const ff_base = new_mach<MyState, MyAction>(game, 60, 10_000_000);
  register_action(ff_base, { time: 16, type: "add", value: 1 });
  compute(ff_base, game, 16);
  await bench("fast_forward (+100k ticks)", () => {
    fast_forward(ff_base, game, 16 + 100_000 * 16);
  }, N);

  console.log("\n...done.");
}

main().catch(console.error);
