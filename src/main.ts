import { done, fail, type Result } from 'lite-fp';
import type { Serializer } from './adapters';

export type Time = number; // 48-bit
export type Tick = number; // 48-bit

export type Action<A> = A & { time: Time };
export type StateLogs<S> = Record<Tick, S>;
export type ActionLogs<A> = Record<Tick, Action<A>[]>;

/**
 * 'rollback': late actions delete future cached states and recompute (games/netcode).
 * 'ledger':   history is immutable; late actions are rejected with ACTION_IN_PAST
 *             (trading bots, financial records).
 */
export type MachMode = 'rollback' | 'ledger';

export type MachError = 'ACTION_IN_PAST' | 'COMPUTE_BEHIND_HEAD';

export type Mach<S, A> = {
  mode: MachMode,
  ticks_per_second: number,
  max_tick_travel: Tick,
  genesis_tick: Tick,
  cached_tick: Tick,
  state_logs: StateLogs<S>,
  action_logs: ActionLogs<A>,
  last_state: S,
};

export type Game<S, A> = {
  init: () => S,
  when: (action: Action<A>, state: S) => S,
  tick: (state: S) => S,
};

export function new_mach<S, A>(
  game: Game<S, A>,
  ticks_per_second: number,
  max_ms_travel: number,
  opts?: { mode?: MachMode },
): Mach<S, A> {
  if (ticks_per_second <= 0) {
    throw new Error("ticks_per_second must be a positive number.");
  }
  if (max_ms_travel < 0) {
    throw new Error("max_ms_travel cannot be negative.");
  }

  const mach: Mach<S, A> = {
    mode: opts?.mode ?? 'rollback',
    ticks_per_second,
    max_tick_travel: 0, // Temporary value
    genesis_tick: Number.MAX_SAFE_INTEGER,
    cached_tick: Number.MIN_SAFE_INTEGER,
    state_logs: {},
    action_logs: {},
    last_state: game.init(),
  };
  mach.max_tick_travel = time_to_tick(mach, max_ms_travel);
  return mach;
}

export function time_to_tick<S, A>(mach: Mach<S, A>, time: Time): Tick {
  return Math.floor((time / 1000) * mach.ticks_per_second);
}

export function tick_to_time(tick: Tick, ticks_per_second: number): Time {
  return (tick * 1000) / ticks_per_second;
}

// Inserts an action into action_logs, sorting by time
function insertOrdered<A>(
  action_logs: Action<A>[],
  action: Action<A>,
) {
  let low = 0;
  let high = action_logs.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (action_logs[mid]!.time < action.time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  action_logs.splice(low, 0, action);
}

// JSON that tolerates BigInt values (serialized as strings)
export function stable_stringify(value: any): string {
  return JSON.stringify(value, (_, v) =>
    typeof v === 'bigint' ? v.toString() + 'n' : v
  );
}

export function register_action<S, A>(mach: Mach<S, A>, action: Action<A>): Result<void, MachError> {
  var time = action.time;
  var tick = time_to_tick(mach, time);
  var hash = stable_stringify(action);

  // Ledger mode: never rewrite published history.
  // Guard runs before any mutation so a rejected action has zero side effects.
  if (mach.mode === 'ledger' && tick < mach.cached_tick) {
    return fail('ACTION_IN_PAST');
  }

  // Initilize this tick's actions
  if (!mach.action_logs[tick]) {
    mach.action_logs[tick] = [];
  }

  // Updates the first action tick
  mach.genesis_tick = Math.min(mach.genesis_tick, tick);

  // Get this tick's actions
  var actions = mach.action_logs[tick]!;

  // If the message is duplicated, skip it
  for (let action of actions) {
    if (stable_stringify(action) == hash) {
      return done(undefined);
    }
  }

  // Rollback mode: deletes all >tick states so compute rebuilds them.
  // Ledger mode keeps every cached state untouched.
  if (mach.mode === 'rollback') {
    for (let t = tick + 1; t <= mach.cached_tick; ++t) {
      delete mach.state_logs[t];
    }
    mach.cached_tick = Math.min(mach.cached_tick, tick);
  }

  // Pushes the action
  insertOrdered(actions, action);
  return done(undefined);
}

export function compute<S, A>(mach: Mach<S, A>, game: Game<S, A>, time: Time): S {
  var end_t = time_to_tick(mach, time);

  // Ledger mode never travels backwards; plain compute clamps to the head.
  // Use try_compute to get an explicit COMPUTE_BEHIND_HEAD error instead.
  if (mach.mode === 'ledger' && end_t < mach.cached_tick) {
    end_t = mach.cached_tick;
  }

  var ini_t = mach.cached_tick;
  var state = mach.state_logs[ini_t];

  if (!state) {
    state = game.init();
    ini_t = Math.min(mach.genesis_tick, end_t);
  }

  if (end_t - ini_t > mach.max_tick_travel) {
    return state;
  }

  // NOTE: actions of tick X happen AFTER its recorded state
  for (var t = ini_t; t <= end_t; ++t) {
    // Caches this tick
    mach.cached_tick = Math.max(mach.cached_tick, t);
    mach.state_logs[t] = state;

    // Computes the tick
    state = game.tick(state);

    // Computes the actions
    var actions = mach.action_logs[t] || [];
    for (var action of actions) {
      state = game.when(action, state);
    }
  }

  mach.last_state = state;
  return state;
}

/**
 * Like compute, but ledger mode returns an explicit Err instead of clamping
 * when asked to travel behind the head tick.
 */
export function try_compute<S, A>(mach: Mach<S, A>, game: Game<S, A>, time: Time): Result<S, MachError> {
  const end_t = time_to_tick(mach, time);
  if (mach.mode === 'ledger' && end_t < mach.cached_tick) {
    return fail('COMPUTE_BEHIND_HEAD');
  }
  return done(compute(mach, game, time));
}

export function run<S, A>(mach: Mach<S, A>, game: Game<S, A>, action: Action<A>): S {
  // Register the action in the machine
  register_action(mach, action);
  // Compute and return the new state up to the action's time
  return compute(mach, game, action.time)
}

export function commit<S, A>(mach: Mach<S, A>, time: Time) {
  const commit_tick = time_to_tick(mach, time);
  // Delete states and actions up to the commit_tick
  for (let t = mach.genesis_tick; t < commit_tick; ++t) {
    delete mach.state_logs[t];
    delete mach.action_logs[t];
  }
  // Update genesis_tick to reflect the new oldest point
  mach.genesis_tick = Math.max(mach.genesis_tick, commit_tick);
}

/**
 * Serialize a machine. Without a serializer, emits plain (bigint-safe) JSON —
 * the historical format. With one, states/actions are encoded by it inside an
 * enveloped document (`__sm_format__: 1`), unlocking BigInt/Map/Set states.
 */
export function serialize_machine<S, A>(
  mach: Mach<S, A>,
  serializer?: Serializer<S, A>,
): string {
  if (!serializer) {
    return stable_stringify(mach);
  }

  const state_logs: Record<Tick, string> = {};
  for (const tick of Object.keys(mach.state_logs)) {
    const t = Number(tick);
    state_logs[t] = serializer.stringify_state(mach.state_logs[t]!);
  }
  const action_logs: Record<Tick, string[]> = {};
  for (const tick of Object.keys(mach.action_logs)) {
    const t = Number(tick);
    action_logs[t] = mach.action_logs[t]!.map(serializer.stringify_action);
  }

  return JSON.stringify({
    __sm_format__: 1,
    mode: mach.mode,
    ticks_per_second: mach.ticks_per_second,
    max_tick_travel: mach.max_tick_travel,
    genesis_tick: mach.genesis_tick,
    cached_tick: mach.cached_tick,
    state_logs,
    action_logs,
    last_state: serializer.stringify_state(mach.last_state),
  });
}

export function deserialize_machine<S, A>(
  json_string: string,
  serializer?: Serializer<S, A>,
): Mach<S, A> {
  const raw = JSON.parse(json_string);

  // Machines saved before modes existed have no `mode`; default to rollback.
  if (!raw.__sm_format__) {
    return { mode: 'rollback', ...raw };
  }

  if (!serializer) {
    throw new Error("Enveloped machine requires a serializer to decode states.");
  }

  const state_logs: Record<Tick, S> = {};
  for (const tick of Object.keys(raw.state_logs)) {
    state_logs[Number(tick)] = serializer.parse_state(raw.state_logs[tick]);
  }
  const action_logs: Record<Tick, Action<A>[]> = {};
  for (const tick of Object.keys(raw.action_logs)) {
    action_logs[Number(tick)] = raw.action_logs[tick].map(serializer.parse_action);
  }

  return {
    mode: raw.mode ?? 'rollback',
    ticks_per_second: raw.ticks_per_second,
    max_tick_travel: raw.max_tick_travel,
    genesis_tick: raw.genesis_tick,
    cached_tick: raw.cached_tick,
    state_logs,
    action_logs,
    last_state: serializer.parse_state(raw.last_state),
  };
}

export function reset_machine<S, A>(mach: Mach<S, A>, game: Game<S, A>) {
  mach.genesis_tick = Number.MAX_SAFE_INTEGER;
  mach.cached_tick = Number.MIN_SAFE_INTEGER;
  mach.state_logs = {};
  mach.action_logs = {};
  mach.last_state = game.init();
}

export function get_state_at_tick<S, A>(mach: Mach<S, A>, tick: Tick): S | undefined {
  return mach.state_logs[tick];
}

export function get_action_at_tick<S, A>(mach: Mach<S, A>, tick: Tick): Action<A>[] | undefined {
  return mach.action_logs[tick];
}

export function get_cached_state<S, A>(mach: Mach<S, A>): S | undefined {
  // Return the most recently cached state
  if (mach.cached_tick !== Number.MIN_SAFE_INTEGER) {
    return mach.state_logs[mach.cached_tick];
  }

  // If no cached state, return genesis state if it exists
  if (mach.genesis_tick !== Number.MAX_SAFE_INTEGER) {
    return mach.state_logs[mach.genesis_tick];
  }

  return undefined;
}

export function get_latest_state<S, A>(mach: Mach<S, A>): S {
  return mach.last_state;
}
