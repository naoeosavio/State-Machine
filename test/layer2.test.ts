import { describe, it, assert, run_all_tests } from './test_utils';
import * as Mach from '../src/main';
import { create_layer2 } from '../src/layer2';

type TestState = {
  counter: number;
  values: number[];
};

type TestAction = 
  | { $: 'increment', amount: number, time: number }
  | { $: 'add_value', value: number, time: number };

const test_game: Mach.Game<TestState, TestAction> = {
  init: () => ({ counter: 0, values: [] }),
  
  when: (action: Mach.Action<TestAction>, state: TestState) => {
    switch (action.$) {
      case 'increment':
        return { ...state, counter: state.counter + action.amount };
      case 'add_value':
        return { ...state, values: [...state.values, action.value] };
      default:
        return state;
    }
  },
  
  tick: (state: TestState) => state,
};

describe('Layer2 System', () => {
  it('should create layer2 instance with genesis snapshot', () => {
    const mach = Mach.new_mach(test_game, 60, 10000);
    const layer2 = create_layer2(mach, test_game, {
      snapshot_interval: 10,
      hash_algorithm: 'custom',
      schema_version: 1,
    });
    
    const metrics = layer2.get_metrics();
    assert.equal(metrics.total_snapshots, 1);
    assert.equal(metrics.total_log_entries, 0);
    assert.ok(metrics.chain_integrity);
  });
  
  it('should register actions with idempotent actionId', () => {
    const mach = Mach.new_mach(test_game, 60, 10000);
    const layer2 = create_layer2(mach, test_game);
    
    const action1: TestAction = { $: 'increment', amount: 5, time: 1000 };
    const action2: TestAction = { $: 'increment', amount: 3, time: 2000 };
    
    layer2.register_action_with_id(action1, 'action-1');
    layer2.register_action_with_id(action2, 'action-2');
    
    const metrics = layer2.get_metrics();
    assert.equal(metrics.total_log_entries, 2);
    assert.equal(metrics.action_id_count, 2);
    
    const entry1 = layer2.get_log_entry_by_action_id('action-1');
    const entry2 = layer2.get_log_entry_by_action_id('action-2');
    
    assert.ok(entry1 !== null);
    assert.ok(entry2 !== null);
    assert.equal((entry1!.action! as any).amount, 5);
    assert.equal((entry2!.action! as any).amount, 3);
  });
  
  it('should prevent duplicate actionId registration', () => {
    const mach = Mach.new_mach(test_game, 60, 10000);
    const layer2 = create_layer2(mach, test_game);
    
    const action1: TestAction = { $: 'increment', amount: 5, time: 1000 };
    const action2: TestAction = { $: 'increment', amount: 10, time: 2000 };
    
    layer2.register_action_with_id(action1, 'duplicate-id');
    layer2.register_action_with_id(action2, 'duplicate-id');
    
    const metrics = layer2.get_metrics();
    assert.equal(metrics.total_log_entries, 1);
    assert.equal(metrics.action_id_count, 1);
    
    const entry = layer2.get_log_entry_by_action_id('duplicate-id');
    assert.equal((entry!.action! as any).amount, 5);
  });
  
  it('should create incremental snapshots', () => {
    const mach = Mach.new_mach(test_game, 1, 10000);
    const layer2 = create_layer2(mach, test_game, { snapshot_interval: 5 });
    
    for (let i = 1; i <= 20; i++) {
      const action: TestAction = { $: 'increment', amount: 1, time: i * 1000 };
      layer2.register_action_with_id(action, `action-${i}`);
    }
    
    const metrics = layer2.get_metrics();
    assert.equal(metrics.total_log_entries, 20);
    
    const snapshots = layer2.export_snapshots();
    assert.ok(snapshots.length > 1);
    
    for (let i = 1; i < snapshots.length; i++) {
      assert.ok(snapshots[i].previous_snapshot_hash !== null);
      assert.equal(snapshots[i].previous_snapshot_hash, snapshots[i-1].hash);
    }
  });
  
  it('should replay from snapshot', () => {
    const mach = Mach.new_mach(test_game, 1, 10000);
    const layer2 = create_layer2(mach, test_game, { snapshot_interval: 10 });
    
    for (let i = 1; i <= 30; i++) {
      const action: TestAction = { $: 'increment', amount: 1, time: i * 1000 };
      layer2.register_action_with_id(action, `action-${i}`);
    }
    
    const snapshots = layer2.export_snapshots();
    assert.ok(snapshots.length > 1);
    
    const middle_snapshot = snapshots[Math.floor(snapshots.length / 2)];
    const target_tick = middle_snapshot.tick + 5;
    
    const replayed_state = layer2.replay_from_snapshot(middle_snapshot.snapshot_id, target_tick);
    assert.ok(replayed_state !== null);
    assert.equal((replayed_state as any).counter, target_tick);
  });
  
  it('should maintain chain integrity', () => {
    const mach = Mach.new_mach(test_game, 60, 10000);
    const layer2 = create_layer2(mach, test_game);
    
    for (let i = 1; i <= 5; i++) {
      const action: TestAction = { $: 'increment', amount: i, time: i * 1000 };
      layer2.register_action_with_id(action, `action-${i}`);
    }
    
    const integrity = layer2.get_chain_integrity();
    assert.ok(integrity.valid);
    assert.equal(integrity.invalid_hashes.length, 0);
    
    const log = layer2.export_log();
    for (let i = 1; i < log.length; i++) {
      assert.equal(log[i].previous_hash, log[i-1].hash);
    }
  });
  
  it('should support schema migrations', () => {
    const mach = Mach.new_mach(test_game, 60, 10000);
    const layer2 = create_layer2(mach, test_game, { schema_version: 1 });
    
    layer2.add_schema_migration({
      from_version: 1,
      to_version: 2,
      migrate: (data) => ({
        ...data,
        migrated: true,
        version: 2,
      }),
    });
    
    layer2.add_schema_migration({
      from_version: 2,
      to_version: 3,
      migrate: (data) => ({
        ...data,
        double_migrated: true,
        version: 3,
      }),
    });
    
    const test_data = { value: 42, schema_version: 1 };
    const migrated = layer2.migrate_data(test_data, 3);
    
    assert.equal((migrated as any).version, 3);
    assert.ok((migrated as any).migrated);
    assert.ok((migrated as any).double_migrated);
    assert.equal((migrated as any).value, 42);
  });
  
  it('should handle pessimistic locking', () => {
    const mach = Mach.new_mach(test_game, 60, 10000);
    const layer2 = create_layer2(mach, test_game);
    
    const lock1 = layer2.acquire_lock('resource-1', 'owner-1', 'pessimistic', 5000);
    assert.ok(lock1 !== null);
    
    const lock2 = layer2.acquire_lock('resource-1', 'owner-2', 'pessimistic');
    assert.equal(lock2, null);
    
    const verified = layer2.verify_lock('resource-1', lock1!);
    assert.ok(verified === true);
    
    const released = layer2.release_lock('resource-1', lock1!);
    assert.ok(released === true);
    
    const lock3 = layer2.acquire_lock('resource-1', 'owner-3', 'pessimistic');
    assert.ok(lock3 !== null);
  });
  
  it('should handle optimistic locking with expiration', async () => {
    const mach = Mach.new_mach(test_game, 60, 10000);
    const layer2 = create_layer2(mach, test_game);
    
    const lock = layer2.acquire_lock('resource-2', 'owner-1', 'optimistic', 100);
    assert.ok(lock !== null);
    
    await new Promise(resolve => setTimeout(resolve, 150));
    
    const verified = layer2.verify_lock('resource-2', lock!);
    assert.ok(verified === false);
    
    const new_lock = layer2.acquire_lock('resource-2', 'owner-2', 'optimistic');
    assert.ok(new_lock !== null);
  });
  
  it('should export and verify complete log', () => {
    const mach = Mach.new_mach(test_game, 60, 10000);
    const layer2 = create_layer2(mach, test_game);
    
    const actions: TestAction[] = [
      { $: 'increment', amount: 1, time: 1000 },
      { $: 'add_value', value: 42, time: 2000 },
      { $: 'increment', amount: 2, time: 3000 },
    ];
    
    actions.forEach((action, i) => {
      layer2.register_action_with_id(action, `test-action-${i}`);
    });
    
    const log = layer2.export_log();
    const snapshots = layer2.export_snapshots();
    
    assert.equal(log.length, 3);
    assert.equal(snapshots.length, 1);
    
    for (const entry of log) {
      assert.ok(entry.entry_id.length > 0);
      assert.ok(entry.hash.length > 0);
      assert.ok(entry.timestamp > 0);
      assert.ok(entry.action_id !== null);
    }
    
    const metrics = layer2.get_metrics();
    assert.ok(metrics.current_hash.length > 0);
    assert.equal(metrics.active_locks, 0);
  });
});

run_all_tests();

