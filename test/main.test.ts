import * as Mach from '../src/main';
import { done, fail, isDone, isFail, err, val } from 'lite-fp';
import { assert, describe, it } from './utils';

// Test Suite
type State = { count: number };
type Action = { type: "inc", time: number } | { type: "dec", time: number };

const game: Mach.Game<State, Action> = {
  init: () => ({ count: 0 }),
  when: (action, state) => {
    switch (action.type) {
      case "inc": return { count: state.count + 1 };
      case "dec": return { count: state.count - 1 };
    }
  },
  tick: (state) => ({ count: state.count }), // No change on tick
};

describe("State Machine Core", () => {

  it("should create a new machine with correct defaults", () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 1000);
    assert.ok(mach.ticks_per_second === 60, "ticks_per_second should be 60");
    assert.ok(mach.max_tick_travel === 60, "max_tick_travel should be 60");
    assert.ok(mach.genesis_tick === Number.MAX_SAFE_INTEGER, "genesis_tick should be Infinity");
    assert.ok(mach.cached_tick === Number.MIN_SAFE_INTEGER, "cached_tick should be -Infinity");
  });

  it("should throw an error for invalid new_mach arguments", () => {
    assert.throws(() => Mach.new_mach(game, 0, 1000), "ticks_per_second must be a positive number.");
    assert.throws(() => Mach.new_mach(game, 60, -1), "max_ms_travel cannot be negative.");
  });

  it("should convert time to ticks correctly", () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 1000);
    const tick = Mach.time_to_tick(mach, 1000);
    assert.equal(tick, 60, "1000ms should be 60 ticks");
    assert.equal(Mach.tick_to_time(60, 60), 1000, "tick 60 at 60tps should be 1000ms");
  });

  it("should register an action and update genesis_tick", () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 1000);
    const action: Action = { type: "inc", time: 500 };
    Mach.register_action(mach, action);
    const tick = Mach.time_to_tick(mach, 500);
    assert.equal(mach.genesis_tick, tick, "genesis_tick should be updated");
    assert.equal(mach.action_logs[tick]?.length, 1, "action should be in logs");
    assert.deepEqual(mach.action_logs[tick]?.[0], action, "action content should be correct");
  });

  it("should skip duplicated actions", () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 1000);
    const action: Action = { type: "inc", time: 500 };
    Mach.register_action(mach, action);
    Mach.register_action(mach, action);
    const tick = Mach.time_to_tick(mach, 500);
    assert.equal(mach.action_logs[tick]?.length, 1, "duplicated action should not be registered twice");
  });

  it("should keep actions ordered by time inside a tick", () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 1000);
    Mach.register_action(mach, { type: "inc", time: 508 });
    Mach.register_action(mach, { type: "dec", time: 502 });
    const tick = Mach.time_to_tick(mach, 500);
    const times = mach.action_logs[tick]!.map(a => a.time);
    assert.deepEqual(times, [502, 508], "actions should be sorted by time");
  });

  it("should compute the state correctly", () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 1000);
    Mach.register_action(mach, { type: "inc", time: 500 });
    Mach.register_action(mach, { type: "inc", time: 600 });
    const state = Mach.compute(mach, game, 600);
    assert.equal(state.count, 2, `Final state should be 2, but was ${state.count}`);
  });

  it("should run an action and compute the state", () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 1000);
    const result = Mach.run(mach, game, { type: "inc", time: 500 });
    assert.ok(isDone(result), "run should succeed for a fresh machine");
    if (isDone(result)) {
      assert.equal(val(result).count, 1, "State should be 1 after run");
    }
    const currentState = Mach.compute(mach, game, 500);
    assert.equal(currentState?.count, 1, "compute should return the computed state");
  });

  it("should commit and clear old logs", () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 1000);
    Mach.register_action(mach, { type: "inc", time: 100 }); // tick 6
    Mach.register_action(mach, { type: "inc", time: 200 }); // tick 12
    Mach.compute(mach, game, 300); // tick 18

    const commit_time = 150; // tick 9
    Mach.commit(mach, commit_time);

    const commit_tick = Mach.time_to_tick(mach, commit_time);
    assert.equal(mach.genesis_tick, commit_tick, "genesis_tick should be updated to commit_tick");
    assert.ok(Mach.get_state_at_tick(mach, 6) === undefined, "State at tick 6 should be deleted");
    assert.ok(Mach.get_action_at_tick(mach, 6) === undefined, "Action at tick 6 should be deleted");
    assert.ok(Mach.get_state_at_tick(mach, 12) !== undefined, "State at tick 12 should exist");
  });

  it("should serialize and deserialize a machine", () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 1000);
    Mach.run(mach, game, { type: "inc", time: 500 });

    const json = Mach.serialize_machine(mach);
    const newMach = Mach.deserialize_machine<State, Action>(json);

    assert.equal(newMach.ticks_per_second, 60, "ticks_per_second should match");
    assert.equal(newMach.cached_tick, mach.cached_tick, "cached_tick should match");
    const state = Mach.compute(newMach, game, 500);
    assert.equal(state?.count, 1, "State should be preserved after deserialization");
  });

  it("should reset a machine", () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 1000);
    Mach.run(mach, game, { type: "inc", time: 500 });
    Mach.reset_machine(mach, game);
    assert.equal(mach.genesis_tick, Number.MAX_SAFE_INTEGER, "genesis_tick should be reset");
    assert.equal(mach.cached_tick, Number.MIN_SAFE_INTEGER, "cached_tick should be reset");
    assert.equal(Object.keys(mach.state_logs).length, 0, "state_logs should be empty");
    assert.equal(Object.keys(mach.action_logs).length, 0, "action_logs should be empty");
  });

  it("pre/post tick helpers return expected snapshots", () => {
    type S2 = { n: number };
    type A2 = { type: "add", time: number, by: number };

    const game2: Mach.Game<S2, A2> = {
      init: () => ({ n: 0 }),
      when: (action, state) => ({ n: state.n + action.by }),
      tick: (state) => ({ n: state.n + 1 }),
    };

    const mach2 = Mach.new_mach<S2, A2>(game2, 60, 1000);
    const t = 1000; // tick 60

    const pre0 = Mach.get_latest_state(mach2);
    const post0 = Mach.compute(mach2, game2, t);
    assert.equal(pre0.n, 0, `pre-tick should be 0, got ${pre0.n}`);
    assert.equal(post0.n, 1, `post-tick should be 1, got ${post0.n}`);

    // After registering an action at the same time, pre-tick stays the same,
    // post-tick includes tick + action
    Mach.register_action(mach2, { type: "add", time: t, by: 5 });
    const pre1 = Mach.get_latest_state(mach2);
    const post1 = Mach.compute(mach2, game2, t);
    assert.equal(pre1.n, 1, `pre-tick should remain 1, got ${pre1.n}`);
    assert.equal(post1.n, 6, `post-tick should be 6 (1 + 5), got ${post1.n}`);
  });

});

describe("Dual Mode (rollback x ledger)", () => {

  it("defaults to rollback mode", () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 1000);
    assert.equal(mach.mode, 'rollback', "default mode should be rollback");
  });

  it("stores an explicit ledger mode", () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 1000, { mode: 'ledger' });
    assert.equal(mach.mode, 'ledger', "mode should be ledger");
  });

  it("rollback mode recomputes on late actions (netcode)", () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 10000);
    Mach.run(mach, game, { type: "inc", time: 600 });
    assert.equal(Mach.get_latest_state(mach).count, 1, "count should be 1");

    const result = Mach.register_action(mach, { type: "inc", time: 500 }); // late
    assert.ok(isDone(result), "late action must be accepted in rollback mode");

    const state = Mach.compute(mach, game, 600);
    assert.equal(state.count, 2, "late action should be replayed into the state");
  });

  it("ledger mode rejects late actions without touching history", () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 10000, { mode: 'ledger' });
    Mach.register_action(mach, { type: "inc", time: 500 });
    Mach.register_action(mach, { type: "inc", time: 600 });
    Mach.compute(mach, game, 600);
    const tick_500 = Mach.time_to_tick(mach, 500);

    const result = Mach.register_action(mach, { type: "inc", time: 300 }); // late
    assert.ok(isFail(result), "late action must be rejected in ledger mode");
    if (isFail(result)) {
      assert.equal(err(result), 'ACTION_IN_PAST', "error should be ACTION_IN_PAST");
    }

    assert.ok(Mach.get_state_at_tick(mach, tick_500) !== undefined,
      "cached history must remain untouched after rejection");

    const again = Mach.compute(mach, game, 600);
    assert.equal(again.count, 2, "rejected action must not affect the state");
  });

  it("both modes agree on punctual action sequences", () => {
    const actions: Action[] = [
      { type: "inc", time: 500 },
      { type: "dec", time: 700 },
      { type: "inc", time: 900 },
    ];

    const rb = Mach.new_mach<State, Action>(game, 60, 10000);
    const ld = Mach.new_mach<State, Action>(game, 60, 10000, { mode: 'ledger' });

    for (const action of actions) {
      assert.ok(isDone(Mach.register_action(rb, action)));
      assert.ok(isDone(Mach.register_action(ld, action)));
      Mach.compute(rb, game, action.time);
      Mach.compute(ld, game, action.time);
    }

    const rb_raw: any = JSON.parse(Mach.serialize_machine(rb));
    const ld_raw: any = JSON.parse(Mach.serialize_machine(ld));
    delete rb_raw.mode;
    delete ld_raw.mode;
    assert.deepEqual(rb_raw, ld_raw,
      "punctual sequences must produce identical machines (modulo mode)");
    assert.equal(rb.last_state.count, 1, "rollback net count should be 1");
    assert.equal(ld.last_state.count, 1, "ledger net count should be 1");
  });

  it("try_compute errors behind head in ledger; plain compute clamps", () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 10000, { mode: 'ledger' });
    Mach.run(mach, game, { type: "inc", time: 600 });
    assert.equal(Mach.get_latest_state(mach).count, 1, "head count should be 1");

    const result = Mach.try_compute(mach, game, 300);
    assert.ok(isFail(result), "traveling behind head must fail in ledger mode");
    if (isFail(result)) {
      assert.equal(err(result), 'COMPUTE_BEHIND_HEAD', "error should be COMPUTE_BEHIND_HEAD");
    }

    const clamped = Mach.compute(mach, game, 300);
    assert.equal(clamped.count, 1, "plain compute clamps to head state");

    const ok_result = Mach.try_compute(mach, game, 700);
    assert.ok(isDone(ok_result), "forward compute succeeds");
    if (isDone(ok_result)) {
      assert.equal(val(ok_result).count, 1, "state unchanged by forward step");
    }
  });

  it("deserialization defaults missing mode to rollback", () => {
    const mach = Mach.new_mach<State, Action>(game, 60, 1000);
    Mach.run(mach, game, { type: "inc", time: 500 });

    const raw = JSON.parse(Mach.serialize_machine(mach));
    delete raw.mode;
    const restored = Mach.deserialize_machine<State, Action>(JSON.stringify(raw));

    assert.equal(restored.mode, 'rollback', "missing mode should default to rollback");
    assert.equal(Mach.compute(restored, game, 500).count, 1, "state preserved");
  });

});

