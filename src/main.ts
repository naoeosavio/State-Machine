export type Time = number; // 48-bit
export type Tick = number; // 48-bit

export type Action<A> = A & { time: Time };
export type StateLogs<S> = Record<Tick, S>;
export type ActionLogs<A> = Record<Tick, Action<A>[]>;

export type Mach<S, A> = {
  ticks_per_second: number,
  max_tick_travel: Tick,
  genesis_tick: Tick,
  cached_tick: Tick,
  state_logs: StateLogs<S>,
  action_logs: ActionLogs<A>,
};

export type Game<S, A> = {
  init: () => S,
  when: (action: Action<A>, state: S) => S,
  tick: (state: S) => S,
};

// TODO: new_mach function
export function new_mach<S, A>(ticks_per_second: number, max_time_travel: number): Mach<S, A> {
  if (ticks_per_second <= 0) {
    throw new Error("ticks_per_second must be a positive number.");
  }
  if (max_time_travel < 0) {
    throw new Error("max_time_travel cannot be negative.");
  }

  const mach: Mach<S, A> = {
    ticks_per_second,
    max_tick_travel: 0, // Temporary value
    genesis_tick: Infinity,
    cached_tick: -Infinity,
    state_logs: {},
    action_logs: {},
  };
  mach.max_tick_travel = time_to_tick(mach, max_time_travel);
  return mach;
}

export function time_to_tick<S, A>(mach: Mach<S, A>, time: Time): Tick {
  return Math.floor(time / 1000 * mach.ticks_per_second);
}

// Inserts an action into action_logs, sorting by time
function insertOrdered<A>(
  action_logs: Action<A>[],
  action: Action<A>,
) {
  let low = 0;
  let high = action_logs.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (action_logs[mid]!.time < action.time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  action_logs.splice(low, 0, action);
}

export function register_action<S, A>(mach: Mach<S, A>, action: Action<A>) {
  var time = action.time;
  var tick = time_to_tick(mach, time);
  var hash = JSON.stringify(action);

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
    if (JSON.stringify(action) == hash) {
      return;
    }
  }

  // Deletes all >tick states
  for (let t = tick + 1; t <= mach.cached_tick; ++t) {
    delete mach.state_logs[t];
  }
  mach.cached_tick = Math.min(mach.cached_tick, tick);

  // Pushes the action
  insertOrdered(actions, action);
}

export function compute<S, A>(mach: Mach<S, A>, game: Game<S, A>, time: Time): S {
  var ini_t = mach.cached_tick;
  var end_t = time_to_tick(mach, time);
  var state = mach.state_logs[ini_t];

  if (!state) {
    state = game.init();
    ini_t = mach.genesis_tick;
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

  return state;
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

export function serialize_machine<S, A>(mach: Mach<S, A>): string {
  return JSON.stringify(mach);
}

export function deserialize_machine<S, A>(json_string: string): Mach<S, A> {
  return JSON.parse(json_string);
}

export function reset_machine<S, A>(mach: Mach<S, A>) {
  mach.genesis_tick = Infinity;
  mach.cached_tick = -Infinity;
  mach.state_logs = {};
  mach.action_logs = {};
}

export function get_state_at_tick<S, A>(mach: Mach<S, A>, tick: Tick): S | undefined {
  return mach.state_logs[tick];
}

export function get_action_at_tick<S, A>(mach: Mach<S, A>, tick: Tick): Action<A>[] | undefined {
  return mach.action_logs[tick];
}

export function get_state<S, A>(mach: Mach<S, A>): S | undefined {
  return mach.state_logs[mach.cached_tick] || mach.state_logs[mach.genesis_tick];
}