import { done, fail, isFail, type Result } from 'lite-fp';
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

export type MachError = 'ACTION_IN_PAST' | 'COMPUTE_BEHIND_HEAD' | 'TRAVEL_LIMIT_EXCEEDED';

export type Mach<S, A> = {
  mode: MachMode,
  ticks_per_second: number,
  max_tick_travel: Tick,
  genesis_tick: Tick,
  cached_tick: Tick,
  state_logs: StateLogs<S>,
  action_logs: ActionLogs<A>,
  last_state: S,
  /** Dev guard: deep-freeze every state entering state_logs (enforces pure when/tick). */
  freeze_states?: boolean,
  /** Times compute hit the max_tick_travel guard (observability for silent-stale returns). */
  stale_count?: number,
  /** Auto-commit policy: keep at most this many recent cached ticks (0/undefined = off). */
  autocommit_ticks?: number,
};

/** Current envelope format version for serialize_machine. */
export const MACH_SCHEMA_VERSION = 1;

export type Game<S, A> = {
  init: () => S,
  when: (action: Action<A>, state: S) => S,
  tick: (state: S) => S,
};

export function new_mach<S, A>(
  game: Game<S, A>,
  ticks_per_second: number,
  max_ms_travel: number,
  opts?: { mode?: MachMode, freeze_states?: boolean, autocommit_ticks?: number },
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
    freeze_states: opts?.freeze_states ?? false,
    stale_count: 0,
    autocommit_ticks: opts?.autocommit_ticks ?? 0,
  };
  if (mach.freeze_states) deep_freeze(mach.last_state);
  mach.max_tick_travel = time_to_tick(mach, max_ms_travel);
  return mach;
}

/**
 * Dev-mode purity guard: freezes an object tree so any mutation of cached
 * history throws loudly instead of corrupting rollback silently.
 */
export function deep_freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as any)) {
      deep_freeze((value as any)[key]);
    }
  }
  return value;
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

/**
 * Key-order-independent JSON: object keys are sorted recursively before
 * stringifying, BigInts become "123n" strings. Two structurally equal values
 * always produce the same text — safe for cross-peer dedupe and hashing.
 */
export function canonical_stringify(value: any): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: any): any {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() + 'n' : value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const out: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

export function register_action<S, A>(mach: Mach<S, A>, action: Action<A>): Result<void, MachError> {
  var time = action.time;
  var tick = time_to_tick(mach, time);
  var hash = canonical_stringify(action);

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

  // If the message is duplicated, skip it (canonical compare: key order irrelevant)
  for (let action of actions) {
    if (canonical_stringify(action) == hash) {
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

  // Stale = asking behind the head (nothing to replay => old data) or a gap
  // larger than the allowed travel window.
  if (end_t < ini_t || end_t - ini_t > mach.max_tick_travel) {
    // Surfaced via stale_count (and as Err from try_compute); plain compute
    // keeps its historical silent-stale return.
    mach.stale_count = (mach.stale_count ?? 0) + 1;
    return state;
  }

  // NOTE: actions of tick X happen AFTER its recorded state
  for (var t = ini_t; t <= end_t; ++t) {
    // Caches this tick
    mach.cached_tick = Math.max(mach.cached_tick, t);
    if (mach.freeze_states) deep_freeze(state);
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

  // Auto-commit policy: trim logs older than the retention window.
  const keep = mach.autocommit_ticks ?? 0;
  if (keep > 0 && mach.cached_tick - mach.genesis_tick > keep) {
    commit(mach, tick_to_time(mach.cached_tick - keep, mach.ticks_per_second));
  }

  return state;
}

/**
 * Like compute, but explicit about both failure modes:
 * - COMPUTE_BEHIND_HEAD: ledger mode asked to travel behind the head tick
 * - TRAVEL_LIMIT_EXCEEDED: gap larger than max_tick_travel would silently
 *   return a stale state under plain compute
 */
export function try_compute<S, A>(mach: Mach<S, A>, game: Game<S, A>, time: Time): Result<S, MachError> {
  const end_t = time_to_tick(mach, time);
  if (mach.mode === 'ledger' && end_t < mach.cached_tick) {
    return fail('COMPUTE_BEHIND_HEAD');
  }

  let ini_t = mach.cached_tick;
  if (!mach.state_logs[ini_t]) {
    ini_t = Math.min(mach.genesis_tick, end_t);
  }
  if (end_t < ini_t || end_t - ini_t > mach.max_tick_travel) {
    return fail('TRAVEL_LIMIT_EXCEEDED');
  }

  return done(compute(mach, game, time));
}

/**
 * Pure forward probe: advances from the current head to `time` applying ticks
 * and actions WITHOUT writing any cache or touching the machine. Ideal for
 * backtests over long horizons — zero memory growth per step.
 */
export function fast_forward<S, A>(mach: Mach<S, A>, game: Game<S, A>, time: Time): S {
  const end_t = time_to_tick(mach, time);
  let ini_t = mach.cached_tick;
  let state = mach.state_logs[ini_t];

  if (!state) {
    state = game.init();
    ini_t = Math.min(mach.genesis_tick, end_t);
  }
  if (end_t <= ini_t || end_t - ini_t > mach.max_tick_travel) {
    return state;
  }

  for (var t = ini_t; t <= end_t; ++t) {
    state = game.tick(state);
    var actions = mach.action_logs[t] || [];
    for (var action of actions) {
      state = game.when(action, state);
    }
  }
  return state;
}

/**
 * Register an action and compute up to its time in one step.
 * Ledger mode: fails with ACTION_IN_PAST for late actions (nothing applied).
 */
export function run<S, A>(mach: Mach<S, A>, game: Game<S, A>, action: Action<A>): Result<S, MachError> {
  const registered = register_action(mach, action);
  if (isFail(registered)) {
    return registered;
  }
  return try_compute(mach, game, action.time);
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
    __sm_format__: MACH_SCHEMA_VERSION,
    mode: mach.mode,
    ticks_per_second: mach.ticks_per_second,
    max_tick_travel: mach.max_tick_travel,
    genesis_tick: mach.genesis_tick,
    cached_tick: mach.cached_tick,
    freeze_states: mach.freeze_states ?? false,
    autocommit_ticks: mach.autocommit_ticks ?? 0,
    state_logs,
    action_logs,
    last_state: serializer.stringify_state(mach.last_state),
  });
}

/**
 * Deserialize an enveloped machine. `migrations` upgrade older envelope
 * versions (same shape as layer2 SchemaMigration) before decoding.
 */
export function deserialize_machine<S, A>(
  json_string: string,
  serializer?: Serializer<S, A>,
  migrations?: { from_version: number, to_version: number, migrate: (data: any) => any }[],
): Mach<S, A> {
  const raw = JSON.parse(json_string);

  // Truly ancient saves have no envelope marker at all; default to rollback.
  if (raw.__sm_format__ === undefined) {
    return { mode: 'rollback', ...raw };
  }

  if (!serializer) {
    throw new Error("Enveloped machine requires a serializer to decode states.");
  }

  // Versioned envelope: run pending migrations, reject unknown futures.
  let version: number = raw.__sm_format__;
  let doc: any = raw;
  if (version > MACH_SCHEMA_VERSION) {
    throw new Error(`Machine envelope v${version} is newer than supported v${MACH_SCHEMA_VERSION}.`);
  }
  for (const migration of (migrations ?? []).sort((a, b) => a.from_version - b.from_version)) {
    while (version < MACH_SCHEMA_VERSION && migration.from_version === version) {
      doc = migration.migrate(doc);
      version = migration.to_version;
    }
  }

  const state_logs: Record<Tick, S> = {};
  for (const tick of Object.keys(doc.state_logs)) {
    state_logs[Number(tick)] = serializer.parse_state(doc.state_logs[tick]);
  }
  const action_logs: Record<Tick, Action<A>[]> = {};
  for (const tick of Object.keys(doc.action_logs)) {
    action_logs[Number(tick)] = doc.action_logs[tick].map(serializer.parse_action);
  }

  return {
    mode: doc.mode ?? 'rollback',
    ticks_per_second: doc.ticks_per_second,
    max_tick_travel: doc.max_tick_travel,
    genesis_tick: doc.genesis_tick,
    cached_tick: doc.cached_tick,
    freeze_states: doc.freeze_states ?? false,
    autocommit_ticks: doc.autocommit_ticks ?? 0,
    stale_count: 0,
    state_logs,
    action_logs,
    last_state: serializer.parse_state(doc.last_state),
  };
}

export function reset_machine<S, A>(mach: Mach<S, A>, game: Game<S, A>) {
  mach.genesis_tick = Number.MAX_SAFE_INTEGER;
  mach.cached_tick = Number.MIN_SAFE_INTEGER;
  mach.state_logs = {};
  mach.action_logs = {};
  mach.stale_count = 0;
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
