import * as Mach from '../src/main';
import { create_layer2 } from '../src/layer2';
import { simulated_clock } from '../src/adapters';
import { isDone, isFail, err, val } from 'lite-fp';
import { assert, describe, it, run_all_tests } from './test_utils';

type State = { count: number };
type Action = { type: 'inc', time: number, meta?: { seq: number } };

const game: Mach.Game<State, Action> = {
  init: () => ({ count: 0 }),
  when: (action, state) => ({ count: state.count + 1 }),
  tick: (state) => state,
};

describe('P1: canonical stringify', () => {

  it('is key-order independent', () => {
    const a = Mach.canonical_stringify({ b: 2, a: 1 });
    const b = Mach.canonical_stringify({ a: 1, b: 2 });
    assert.equal(a, b, "key insertion order must not matter");
    assert.equal(a, '{"a":1,"b":2}');
  });

  it('dedupes actions built with different key orders', () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 10000);
    Mach.register_action(mach, { type: 'inc', time: 500 } as any);
    // same logical action, keys in reverse insertion order
    const twin: any = { time: 500, type: 'inc' };
    Mach.register_action(mach, twin);
    const tick = Mach.time_to_tick(mach, 500);
    assert.equal(mach.action_logs[tick]!.length, 1,
      "structurally equal actions must dedupe regardless of key order");
  });

  it('layer2 chains are identical across key orders (cross-peer equality)', () => {
    function run(order: 'abc' | 'cba'): string {
      const sim = simulated_clock(0);
      const mach = Mach.new_mach<State, Action>(game, 60, 10000);
      const layer2 = create_layer2(mach, game, { clock: sim.clock });
      for (let i = 1; i <= 5; ++i) {
        let action: any;
        if (order === 'abc') action = { $: 'inc', amount: i, time: i * 1000 };
        else action = { time: i * 1000, amount: i, $: 'inc' };
        layer2.register_action_with_id(action, `a-${i}`);
        sim.advance(10);
      }
      return layer2.export_chain();
    }
    assert.equal(run('abc'), run('cba'),
      "same actions with different key orders must produce identical chains");
  });

});

describe('P1: dev-mode immutability guard', () => {

  it('deep-freezes cached states when freeze_states is on', () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 10000, { freeze_states: true });
    Mach.run(mach, game, { type: 'inc', time: 500 });
    const cached = Mach.get_state_at_tick(mach, Mach.time_to_tick(mach, 500))!;
    const before = cached.count;
    assert.ok(Object.isFrozen(cached), "cached state must be frozen");
    assert.throws(() => {
      (cached as any).count = before + 99;
    }, "mutating frozen history must throw");
    assert.equal(cached.count, before, "mutation attempt must not take effect");
  });

  it('stays mutable by default', () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 10000);
    Mach.run(mach, game, { type: 'inc', time: 500 });
    const cached = Mach.get_state_at_tick(mach, Mach.time_to_tick(mach, 500))!;
    (cached as any).count = 42; // must not throw
    assert.equal(cached.count, 42);
  });

});

describe('P2: stale detection surfacing', () => {

  it('plain compute keeps silent-stale behavior but counts it', () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 200); // max travel = 12 ticks
    Mach.run(mach, game, { type: 'inc', time: 1000 }); // head at tick 60
    const before = mach.stale_count ?? 0;

    const state = Mach.compute(mach, game, 100); // far behind
    assert.notEqual(state.count, mach.last_state.count,
      "returned value must be the stale pre-head snapshot, not the live state");
    assert.equal(mach.stale_count, before + 1, "stale hit must be counted");
  });

  it('try_compute reports TRAVEL_LIMIT_EXCEEDED instead of stale data', () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 200);
    Mach.run(mach, game, { type: 'inc', time: 1000 });

    const result = Mach.try_compute(mach, game, 100);
    if (!isFail(result)) throw new Error('expected Err');
    assert.equal(err(result), 'TRAVEL_LIMIT_EXCEEDED');

    const ok_result = Mach.try_compute(mach, game, 1100);
    if (!isDone(ok_result)) throw new Error('within travel limit should succeed');
    assert.equal(val(ok_result).count, 1);
  });

});

describe('P2: backtest fast-forward', () => {

  it('advances without growing caches or touching the machine', () => {
    const mach = Mach.new_mach<State, Action>(game, 1, Number.MAX_SAFE_INTEGER / 2);
    Mach.run(mach, game, { type: 'inc', time: 1000 });
    const logs_before = Object.keys(mach.state_logs).length;
    const genesis_before = mach.genesis_tick;

    let probe = mach.last_state;
    for (let t = 2; t <= 100_000; ++t) {
      probe = Mach.fast_forward(mach, game, t * 1000);
    }
    assert.equal(probe.count, 1, "no actions registered => count unchanged");
    assert.equal(Object.keys(mach.state_logs).length, logs_before,
      "fast_forward must not write state_logs");
    assert.equal(mach.genesis_tick, genesis_before, "machine untouched");
  });

  it('matches compute results for the same target', () => {
    const a = Mach.new_mach<State, Action>(game, 1, 100000);
    const b = Mach.new_mach<State, Action>(game, 1, 100000);
    Mach.register_action(a, { type: 'inc', time: 3000 });
    Mach.register_action(b, { type: 'inc', time: 3000 });

    const ff = Mach.fast_forward(b, game, 5000);
    const cc = Mach.compute(a, game, 5000);
    assert.deepEqual(ff, cc, "probe and cached compute must agree");
  });

});

describe('P2: auto-commit policy', () => {

  it('bounds cached history to the retention window', () => {
    const mach = Mach.new_mach<State, Action>(game, 1, Number.MAX_SAFE_INTEGER, { autocommit_ticks: 5 });
    for (let t = 1; t <= 30; ++t) {
      Mach.run(mach, game, { type: 'inc', time: t * 1000 });
    }
    const span = mach.cached_tick - mach.genesis_tick;
    assert.ok(span <= 5 + 1, `span ${span} should stay within retention window`);
    assert.equal(mach.last_state.count, 30, "state correctness unaffected by trimming");
  });

  it('stays off by default', () => {
    const mach = Mach.new_mach<State, Action>(game, 1, Number.MAX_SAFE_INTEGER);
    for (let t = 1; t <= 20; ++t) {
      Mach.run(mach, game, { type: 'inc', time: t * 1000 });
    }
    assert.ok(Object.keys(mach.state_logs).length >= 20, "no trimming without policy");
  });

});

describe('P2: layer2 persistence', () => {

  it('exports, reloads and resumes chaining tamper-evidently', () => {
    const sim = simulated_clock(7);
    const source_mach = Mach.new_mach<State, Action>(game, 1, 1_000_000);
    const source = create_layer2(source_mach, game, { clock: sim.clock, snapshot_interval: 3 });
    for (let i = 1; i <= 10; ++i) {
      source.register_action_with_id({ type: 'inc', time: i * 1000 }, `a-${i}`);
      sim.advance(5);
    }

    const jsonl = source.export_chain();

    const target_mach = Mach.new_mach<State, Action>(game, 1, 1_000_000);
    const target = create_layer2(target_mach, game, { clock: sim.clock, snapshot_interval: 3 });
    const loaded = target.load_chain(jsonl);
    assert.ok(isDone(loaded), "clean chain must load");

    assert.deepEqual(
      target.export_log().map(e => [e.entry_id, e.hash]),
      source.export_log().map(e => [e.entry_id, e.hash]),
      "entries must match byte-for-byte",
    );
    assert.deepEqual(target.export_snapshots().map(s => s.hash),
      source.export_snapshots().map(s => s.hash));

    // Resume appending on top of the restored chain.
    const resumed = target.register_action_with_id({ type: 'inc', time: 11000 }, 'a-11');
    assert.ok(isDone(resumed));
    assert.ok(target.get_metrics().chain_integrity, "restored chain stays valid after append");

    // Replay works off the loaded snapshots.
    const replayed = target.replay_from_snapshot('genesis', 6);
    assert.ok(isDone(replayed) && val(replayed).count === 6, "replay from loaded snapshot works");
  });

  it('rejects tampered payloads with CHAIN_BROKEN', () => {
    const source_mach = Mach.new_mach<State, Action>(game, 1, 1_000_000);
    const source = create_layer2(source_mach, game);
    source.register_action_with_id({ type: 'inc', time: 1000 }, 'a-1');
    source.register_action_with_id({ type: 'inc', time: 2000 }, 'a-2');

    const lines = source.export_chain().split('\n');
    const entry = JSON.parse(lines[1]!);
    entry.action.type = 'dec'; // forge the payload
    lines[1] = JSON.stringify(entry);

    const target = create_layer2(Mach.new_mach<State, Action>(game, 1, 1_000_000), game);
    const result = target.load_chain(lines.join('\n'));
    if (!isFail(result)) throw new Error('tampered chain must fail');
    assert.equal(err(result), 'CHAIN_BROKEN');
    assert.equal(target.get_metrics().total_log_entries, 0, "failed load mutates nothing");
  });

});

describe('P3: save versioning', () => {

  it('envelope carries MACH_SCHEMA_VERSION and round-trips', () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 1000, { mode: 'ledger' });
    Mach.run(mach, game, { type: 'inc', time: 500 });

    const doc = JSON.parse(Mach.serialize_machine(mach, json_ser()));
    assert.equal(doc.__sm_format__, Mach.MACH_SCHEMA_VERSION);

    const restored = Mach.deserialize_machine(Mach.serialize_machine(mach, json_ser()), json_ser());
    assert.equal(restored.mode, 'ledger');
    assert.equal(restored.last_state.count, 1);
  });

  it('runs pending migrations from older envelope versions', () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 1000);
    Mach.run(mach, game, { type: 'inc', time: 500 });

    // Simulate a v0 document that stored count under legacy_count.
    const v0_doc: any = JSON.parse(Mach.serialize_machine(mach, json_ser()));
    v0_doc.__sm_format__ = 0;
    v0_doc.state_logs = Object.fromEntries(
      Object.entries(v0_doc.state_logs).map(([k, s]) => [k, JSON.stringify({ legacy_count: JSON.parse(s as string).count })])
    );
    v0_doc.last_state = JSON.stringify({ legacy_count: 1 });

    const migrations = [{
      from_version: 0,
      to_version: Mach.MACH_SCHEMA_VERSION,
      migrate: (data: any) => {
        const rename = (raw: string) => {
          const parsed = JSON.parse(raw);
          return JSON.stringify({ count: parsed.legacy_count });
        };
        const out = { ...data };
        out.state_logs = Object.fromEntries(
          Object.entries(data.state_logs).map(([k, s]) => [k, rename(s as string)])
        );
        out.last_state = rename(data.last_state);
        return out;
      },
    }];

    const restored = Mach.deserialize_machine(JSON.stringify(v0_doc), json_ser(), migrations);
    assert.equal(restored.last_state.count, 1, "migrated state decodes correctly");
  });

  it('rejects envelopes from the future', () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 1000);
    const doc = JSON.parse(Mach.serialize_machine(mach, json_ser()));
    doc.__sm_format__ = Mach.MACH_SCHEMA_VERSION + 99;
    assert.throws(() => Mach.deserialize_machine(JSON.stringify(doc), json_ser()),
      "future versions must fail loudly, not misparse");
  });

});

// --- helpers ---

function json_ser() {
  // bigint-safe canonical codec matching defaults; explicit for clarity here
  return {
    stringify_state: (s: State) => Mach.canonical_stringify(s),
    parse_state: (raw: string) => JSON.parse(raw),
    stringify_action: (a: Action) => Mach.canonical_stringify(a),
    parse_action: (raw: string) => JSON.parse(raw),
  };
}

run_all_tests();
