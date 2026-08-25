import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as Mach from '../src/main';
import { create_layer2 } from '../src/layer2';
import {
  simulated_clock,
  json_serializer,
  type Serializer,
  type Hasher,
} from '../src/adapters';
import { new_file_store } from '../src/file_store';
import * as Orchestrator from '../src/orchestrator';
import type { EffectStore } from '../src/orchestrator';
import { assert, describe, it } from './utils';

type State = { count: number; big?: bigint };
type Action = { type: 'inc', time: number };

const game: Mach.Game<State, Action> = {
  init: () => ({ count: 0 }),
  when: (action, state) => ({ count: state.count + 1, big: BigInt(state.count + 1) }),
  tick: (state) => state,
};

function feed(layer2: ReturnType<typeof create_layer2<State, Action>>) {
  for (let i = 1; i <= 12; ++i) {
    layer2.register_action_with_id({ type: 'inc', time: i * 1000 }, `a-${i}`);
  }
}

describe('Clock seam', () => {

  it('system clock produces real wall-clock timestamps', () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 10000);
    const before = Date.now();
    const layer2 = create_layer2(mach, game);
    layer2.register_action_with_id({ type: 'inc', time: 1000 }, 'x');
    const stamp = layer2.export_log()[0]!.timestamp;
    assert.ok(stamp >= before && stamp <= Date.now(),
      "system clock timestamps should fall in wall-clock range");
  });

  it('simulated clock makes chains fully reproducible (hashes, ids, stamps)', () => {
    function run(): string {
      const sim = simulated_clock(1000);
      const mach = Mach.new_mach<State, Action>(game, 60, 10000);
      const layer2 = create_layer2(mach, game, { clock: sim.clock });
      for (let i = 1; i <= 12; ++i) {
        layer2.register_action_with_id({ type: 'inc', time: i * 1000 }, `a-${i}`);
        sim.advance(50);
      }
      return JSON.stringify({
        log: layer2.export_log(),
        snapshots: layer2.export_snapshots().map(s => ({ id: s.snapshot_id, hash: s.hash })),
        integrity: layer2.get_chain_integrity(),
      }, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
    }

    const a = run();
    const b = run();
    assert.equal(a, b, "same simulated timeline must produce byte-identical chains");

    const parsed = JSON.parse(a);
    assert.ok(parsed.integrity.valid, "simulated chain must verify");
    const first_entry = JSON.parse(a).log[0];
    assert.equal(first_entry.entry_id, 'entry_' + first_entry.hash.slice(0, 16),
      "entry ids must be derived from content hashes");
  });

});

describe('Hasher seam', () => {

  it('sha256 and sha512 presets both verify but diverge in digests', () => {
    const h256 = run_with_hasher(create_layer2(new_mach_ledger(), game, { hash_algorithm: 'sha256' }));
    const h512 = run_with_hasher(create_layer2(new_mach_ledger(), game, { hash_algorithm: 'sha512' }));

    assert.ok(h256.integrity.valid && h512.integrity.valid, "both presets must verify");
    assert.equal(h256.last_hash.length, 64, "sha256 digest should be 64 hex chars");
    assert.equal(h512.last_hash.length, 128, "sha512 digest should be 128 hex chars");
    assert.notEqual(h256.entries, h512.entries, "different algorithms must diverge");
  });

  it('custom hasher overrides presets without core changes', () => {
    const toy: Hasher = (input) => Buffer.byteLength(input).toString(16).padStart(8, '0');
    const layer2 = create_layer2(new_mach_ledger(), game, { hasher: toy });
    layer2.register_action_with_id({ type: 'inc', time: 1000 }, 'only');

    const entry = layer2.export_log()[0]!;
    assert.notEqual(entry.hash.length, 64, "custom hasher output replaces preset length");
    assert.ok(layer2.get_chain_integrity().valid,
      "chain verification is hasher-agnostic (equality based)");
  });

});

describe('Serializer seam', () => {

  it('default JSON serializer keeps bigint-safe legacy hashing behavior', () => {
    const mach = new_mach_ledger();
    const layer2 = create_layer2(mach, game, { clock: simulated_clock(5).clock });
    feed(layer2);
    assert.ok(layer2.get_chain_integrity().valid,
      "bigint states must hash cleanly under default serializer");
    assert.notEqual(json_serializer<State, Action>().stringify_state({ count: 1, big: 1n }), '',
      "json_serializer exported and functional");
  });

  it('custom serializer round-trips bigint machine state losslessly', () => {
    const bigint_ser: Serializer<State, Action> = {
      stringify_state: (s) => JSON.stringify(s, (_k, v) => typeof v === 'bigint' ? { $b: v.toString() } : v),
      parse_state: (raw) => JSON.parse(raw, (_k, v) => (v && typeof v === 'object' && '$b' in v) ? BigInt(v.$b) : v),
      stringify_action: (a) => JSON.stringify(a),
      parse_action: (raw) => JSON.parse(raw),
    };

    const mach = Mach.new_mach<State, Action>(game, 60, 10000);
    Mach.run(mach, game, { type: 'inc', time: 500 });

    const restored = Mach.deserialize_machine<State, Action>(
      Mach.serialize_machine(mach, bigint_ser),
      bigint_ser,
    );

    assert.equal(typeof restored.last_state.big, 'bigint',
      "bigint must survive serialize/deserialize via custom codec");
    assert.equal(restored.last_state.big, 1n, "bigint value preserved");
    assert.equal(Mach.compute(restored, game, 500).count, 1, "machine functional after round-trip");
  });

});

describe('EffectStore seam', () => {

  function make_memory(): EffectStore {
    const set = new Set<string>();
    return {
      has: k => set.has(k),
      add: k => void set.add(k),
      delete: k => void set.delete(k),
      clear: () => void set.clear(),
      size: () => set.size,
    };
  }

  const scenarios: [string, () => EffectStore][] = [
    ['memory store', make_memory],
    ['file store', () => new_file_store(temp_path())],
  ];

  for (const [name, make] of scenarios) {
    it(`behaves identically on ${name}`, () => {
      const store = make();
      store.add('k1');
      store.add('k2');
      store.add('k1'); // duplicate add
      assert.ok(store.has('k1') && store.has('k2'));
      assert.equal(store.size!(), 2, "duplicate adds must not double-count");

      store.delete!('k1');
      assert.ok(!store.has('k1'));

      store.clear!();
      assert.equal(store.size!(), 0);
    });
  }

  it('file store survives reopen with tombstones', () => {
    const p = temp_path();
    const first = new_file_store(p);
    first.add('persist-me');
    first.add('doomed');
    first.delete!('doomed');

    const second = new_file_store(p); // fresh instance replays the file
    assert.ok(second.has('persist-me'), "added key must persist across reopen");
    assert.ok(!second.has('doomed'), "tombstoned key must stay deleted");

    fs.rmSync(p, { force: true });
  });

  it('memory vs file stores dedupe identically inside orchestrator runs', async () => {
    const p = temp_path();
    const runs: EffectStore[] = [make_memory(), new_file_store(p)];

    for (const seen of runs) {
      const executed: string[] = [];
      const mach = Mach.new_mach<State, Action>(game, 60, 10000);
      const cfg: Orchestrator.SideEffectConfig<State, Action, {}> = {
        mach,
        game,
        generator: () => [{ key: 'effect-1' }],
        executor: async (e) => { executed.push(e.key); },
        seen,
      };
      await Orchestrator.dispatch(cfg, { type: 'inc', time: 100 });
      await Orchestrator.dispatch(cfg, { type: 'inc', time: 200 });
      assert.deepEqual(executed, ['effect-1'],
        "effect must fire once despite repeated dispatch on both stores");
    }

    fs.rmSync(p, { force: true });
  });

});

// --- helpers ---

function new_mach_ledger() {
  return Mach.new_mach<State, Action>(game, 60, 10000);
}

function run_with_hasher(layer2: ReturnType<typeof create_layer2<State, Action>>) {
  feed(layer2);
  return {
    integrity: layer2.get_chain_integrity(),
    last_hash: layer2.get_metrics().current_hash,
    entries: JSON.stringify(layer2.export_log().map(e => e.hash)),
  };
}

let tmp_counter = 0;
function temp_path(): string {
  return path.join(os.tmpdir(), `sm-file-store-test-${process.pid}-${++tmp_counter}.jsonl`);
}

