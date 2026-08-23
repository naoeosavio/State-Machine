import * as Mach from '../src/main';
import * as Orchestrator from '../src/orchestrator';
import { assert, describe, it, run_all_tests } from './test_utils';

// --- Test Setup ---

// 1. Define State and Actions
type State = { count: number; lastAction?: string };
type Action = { type: 'INC'; amount: number } | { type: 'DEC'; amount: number } | { type: 'NOP' };

// 2. Define the core logic (the "game")
const game: Mach.Game<State, Action> = {
  init: () => ({ count: 0 }),
  when: (action, state) => {
    const newState = { ...state, lastAction: action.type };
    switch (action.type) {
      case 'INC':
        return { ...newState, count: state.count + action.amount };
      case 'DEC':
        return { ...newState, count: state.count - action.amount };
      case 'NOP':
        return state; // No change
    }
  },
  tick: (state) => state, // No change on tick
};

// 3. Define Side Effects
type MyEffect = { message: string; type: string };

// 4. Define the Side Effect Generator
const generator: Orchestrator.SideEffectGenerator<State, Action, MyEffect> = (oldState, newState, action) => {
  // Using the action time makes the key deterministic and unique.
  const key = `${action.type}-at-${action.time}`;

  if (newState.count > oldState.count) {
    return [{
      type: 'CountIncreased',
      key: `inc-to-${newState.count}-` + key,
      message: `Count increased from ${oldState.count} to ${newState.count}`
    }];
  }
  if (newState.count < oldState.count) {
    return [{
      type: 'CountDecreased',
      key: `dec-to-${newState.count}-` + key,
      message: `Count decreased from ${oldState.count} to ${newState.count}`
    }];
  }
  return []; // No effect if count is the same
};


describe('Orchestrator.dispatch', () => {

  it('should process an action and execute the resulting side effect', async () => {
    const mach = Mach.new_mach<State, Action>(game,60, 1000);
    const seen = new Set<string>();
    const executedEffects: Orchestrator.SideEffect<MyEffect>[] = [];

    const executor: Orchestrator.SideEffectExecutor<MyEffect> = async (effect) => {
      executedEffects.push(effect);
    };

    const config: Orchestrator.SideEffectConfig<State, Action, MyEffect> = {
      mach, game, generator, executor, seen
    };

    const action: Mach.Action<Action> = { type: 'INC', amount: 5, time: 100 };

    const finalState = await Orchestrator.dispatch(config, action);

    assert.ok(finalState.count === 5, `Final state should be 5, but was ${finalState.count}`);
    assert.ok(executedEffects.length === 1, 'Executor should be called once');
    assert.ok(executedEffects[0]?.type === 'CountIncreased', 'Correct effect type was executed');
    assert.ok(executedEffects[0]?.message === 'Count increased from 0 to 5', 'Correct effect message');
    assert.ok(seen.has('inc-to-5-INC-at-100'), 'Effect key should be cached');
  });

  it('should not execute a side effect if its key is already cached', async () => {
    const mach = Mach.new_mach<State, Action>(game,60, 1000);
    const seen = new Set<string>();
    const executedEffects: Orchestrator.SideEffect<MyEffect>[] = [];
    const executor: Orchestrator.SideEffectExecutor<MyEffect> = async (effect) => {
      executedEffects.push(effect);
    };
    const config: Orchestrator.SideEffectConfig<State, Action, MyEffect> = {
      mach, game, generator, executor, seen
    };

    // Manually add the key to the cache to simulate it being seen before
    seen.add('inc-to-10-INC-at-200');

    const action: Mach.Action<Action> = { type: 'INC', amount: 10, time: 200 };
    const finalState = await Orchestrator.dispatch(config, action);

    assert.ok(finalState.count === 10, 'State should still be updated');
    assert.ok(executedEffects.length === 0, 'Executor should not be called for a cached effect key');
  });

  it('should process a sequence of actions and generate corresponding effects', async () => {
    const mach = Mach.new_mach<State, Action>(game,60, 1000);
    const seen = new Set<string>();
    const executedEffects: Orchestrator.SideEffect<MyEffect>[] = [];
    const executor: Orchestrator.SideEffectExecutor<MyEffect> = async (effect) => {
      executedEffects.push(effect);
    };
    const config: Orchestrator.SideEffectConfig<State, Action, MyEffect> = {
      mach, game, generator, executor, seen
    };

    // Action 1: INC 10
    await Orchestrator.dispatch(config, { type: 'INC', amount: 10, time: 100 });
    assert.ok(Mach.get_latest_state(mach)?.count === 10, 'Count should be 10');
    assert.ok(executedEffects.length === 1, 'Should have 1 executed effect');
    assert.ok(executedEffects[0]?.key === 'inc-to-10-INC-at-100', 'Correct key for first effect');

    // Action 2: DEC 3
    await Orchestrator.dispatch(config, { type: 'DEC', amount: 3, time: 200 });
    assert.ok(Mach.get_latest_state(mach)?.count === 7, 'Count should be 7');
    assert.ok(executedEffects.length === 2, 'Should have 2 executed effects');
    assert.ok(executedEffects[1]?.key === 'dec-to-7-DEC-at-200', 'Correct key for second effect');

    // Action 3: NOP (no state change)
    await Orchestrator.dispatch(config, { type: 'NOP', time: 300 });
    assert.ok(Mach.get_latest_state(mach)?.count === 7, 'Count should still be 7');
    assert.ok(executedEffects.length === 2, 'Should still have 2 executed effects after NOP');
  });

  it('uses post-tick state as "oldState" for first action at a tick', async () => {
    type TState = { count: number };
    type TAction = { type: 'INC'; amount: number };

    const game2: Mach.Game<TState, TAction> = {
      init: () => ({ count: 0 }),
      when: (action, state) => ({ count: state.count + action.amount }),
      // Tick increments once; we expect oldState to reflect this single tick
      tick: (state) => ({ count: state.count + 1 }),
    };

    const mach = Mach.new_mach<TState, TAction>(game2,60, 1000);
    const seen = new Set<string>();
    const seenOldNew: Array<{ old: number; next: number }> = [];

    const generator2: Orchestrator.SideEffectGenerator<TState, TAction, { delta: number }> = (oldState, newState, action) => {
      seenOldNew.push({ old: oldState.count, next: newState.count });
      return [];
    };

    const executor2: Orchestrator.SideEffectExecutor<{ delta: number }> = async (_e) => {};

    const config2: Orchestrator.SideEffectConfig<TState, TAction, { delta: number }> = {
      mach,
      game: game2,
      generator: generator2,
      executor: executor2,
      seen,
    };

    // First-ever action on the machine at time 1000ms (tick 60)
    await Orchestrator.dispatch(config2, { type: 'INC', amount: 5, time: 1000 });

    // We expect the old state seen by the generator to be post-tick (1),
    // and the new state to be post-tick plus action (1 + 5 = 6)
    const snapshot = seenOldNew[0]!;
    assert.ok(snapshot.old === 0, `oldState should be 1 (post-tick), got ${snapshot.old}`);
    assert.ok(snapshot.next === 6, `newState should be 6 (post-tick + action), got ${snapshot.next}`);
  });

  it('orchestrate parallel marks none if any fail', async () => {
    type S = { n: number };
    type A = { type: 'BUMP' };
    type E = { label: string };

    const game2: Mach.Game<S, A> = {
      init: () => ({ n: 0 }),
      when: (_a, s) => ({ n: s.n + 1 }),
      tick: (s) => s,
    };

    const gen: Orchestrator.SideEffectGenerator<S, A, E> = (_prev, _next, action) => {
      return [
        { key: `ok-${action.time}`, label: 'ok' },
        { key: `fail-${action.time}`, label: 'fail' },
      ];
    };

    const executed: string[] = [];
    const exec: Orchestrator.SideEffectExecutor<E> = async (e) => {
      executed.push(e.key);
      if (e.key.startsWith('fail-')) throw new Error('boom');
    };

    const mach = Mach.new_mach<S, A>(game2,60, 1000);
    const seen = new Set<string>();
    const cfg: Orchestrator.SideEffectConfig<S, A, E> = { mach, game: game2, generator: gen, executor: exec, seen };

    await Orchestrator.orchestrate(cfg, { type: 'BUMP', time: 1 }, { strategy: 'parallel' });

    assert.ok(!seen.has('ok-1') && !seen.has('fail-1'), 'No keys should be added on parallel failure');
    assert.ok(executed.length === 2, 'Both effects attempted');
  });

  it('orchestrate allSettled marks only successes', async () => {
    type S = { n: number };
    type A = { type: 'BUMP' };
    type E = { label: string };
    const game2: Mach.Game<S, A> = {
      init: () => ({ n: 0 }),
      when: (_a, s) => ({ n: s.n + 1 }),
      tick: (s) => s,
    };
    const gen: Orchestrator.SideEffectGenerator<S, A, E> = (_prev, _next, action) => (
      [ { key: `ok-${action.time}`, label: 'ok' }, { key: `fail-${action.time}`, label: 'fail' } ]
    );
    const exec: Orchestrator.SideEffectExecutor<E> = async (e) => {
      if (e.key.startsWith('fail-')) throw new Error('boom');
    };
    const mach = Mach.new_mach<S, A>(game2,60, 1000);
    const seen = new Set<string>();
    const cfg: Orchestrator.SideEffectConfig<S, A, E> = { mach, game: game2, generator: gen, executor: exec, seen };

    await Orchestrator.orchestrate(cfg, { type: 'BUMP', time: 2 }, { strategy: 'allSettled' });

    assert.ok(seen.has('ok-2') && !seen.has('fail-2'), 'Only successful effect should be marked in allSettled');
  });

  it('dispatch_with_report returns per-effect statuses', async () => {
    type S = { n: number };
    type A = { type: 'X' };
    type E = { t: string };
    const game2: Mach.Game<S, A> = { init: () => ({ n: 0 }), when: (_a,s) => ({ n: s.n }), tick: s => s };
    const gen: Orchestrator.SideEffectGenerator<S, A, E> = (_p,_n, a) => [
      { key: `k1-${a.time}`, t: '1' },
      { key: `k2-${a.time}`, t: '2' },
    ];
    const seen = new Set<string>([`k1-3`]);
    const exec: Orchestrator.SideEffectExecutor<E> = async (_e) => {};
    const mach = Mach.new_mach<S, A>(game2,60, 1000);
    const { report } = await Orchestrator.dispatch_with_report({ mach, game: game2, generator: gen, executor: exec, seen }, { type: 'X', time: 3 });
    assert.ok(report.total === 2, 'Two effects total');
    assert.ok(report.skipped === 1 && report.executed === 1, 'One skipped, one executed');
  });

});

run_all_tests();
