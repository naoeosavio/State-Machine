# State Machine: A Deterministic State Management System

State Machine is a lightweight, deterministic state management system designed for multiplayer games. It provides a robust framework for handling states, actions, and time-based computations.

## Features

- Deterministic state management
- Action logging and replay
- Time-based tick system
- Efficient state caching
- Support for custom game logic
- Ability to rollback and recalculate states
- Pure side-effect orchestration with idempotency
- Layer2: hash-chained log, snapshots, replay, locks

## Installation

To install and run the project:

1. Clone the repository
2. Run `npm install` to install dependencies
3. Run `npm run build` to build the project

### Types

- `Time`: Represents time as a 48-bit number
- `Tick`: Represents a game tick as a 48-bit number
- `StateLogs<S>`: A record of game states indexed by ticks
- `ActionLogs<A>`: A record of actions indexed by ticks
- `Mach<S, A>`: The main state management object
- `Game<S, A>`: Defines the game logic (init, when, tick functions)

### Main Functions

- `new_mach<S, A>`: Creates a new Mach instance with a specific TPS (ticks per second).
- `time_to_tick<S, A>`: Converts time in milliseconds to ticks.
- `register_action<S, A>`: Registers an action at the corresponding tick. Can be used for local player actions or to synchronize actions from other players in a multiplayer game.
- `compute<S, A>`: Updates the game state based on ticks and registered actions up to a specific point in time.

### General Explanation

- Game: Interface that defines how the game behaves.
  - init: Initializes the game state.
  - when: Defines how the game state changes with an action.
  - tick: Defines how the game state is updated each tick.
- The `init`, `when`, and `tick` functions of the game must be pure to ensure determinism.
- The system supports state rollback, allowing recalculation from a previous point if necessary.
- Ideal for games that require precise synchronization between multiple players.

This system is particularly useful for multiplayer games where precise synchronization and the ability to replay previous states are crucial.

### Usage

```typescript
import { new_mach, register_action, compute, Mach, Game, Time } from '@uwu-games/uwu-state-machine';

// Definition of State and Action types
type State = { /* ... */ };
type Action = 
  | { $: "SetNick", time: Time, pid: UID, name: string }
  | { $: "KeyEvent", time: Time, pid: UID, key: Key, down: boolean };

// Implementation of game logic
function init(): State {
   /* initial state */ 
  };
  
function when(action: Action, state: State): State { 
    // Logic to handle actions
    switch (action.$) {
      case "SetNick":
        // Update player nickname
        break;
      case "KeyEvent":
        // Handle keyboard events
        break;
    }
    return state;
  };

function tick(state: State): State {
    // Update game state each tick
    return state;
  };

// Create a new Game instance 
const game: Game<State, Action> = { init, tick, when };
// Create a new Mach instance (60 ticks per second, max 1000ms of rollback travel)
const mach: Mach<State, Action> = new_mach(game, 60, 1000);

// Register actions
register_action(mach, { $: "SetNick", time: 1000, pid: "player1", name: "Alice" });
register_action(mach, { $: "KeyEvent", time: 1500, pid: "player1", key: "ArrowUp", down: true });

// Compute game state at a specific time
const state = compute(mach, game, 2000);
```

This system is particularly useful for multiplayer games where precise synchronization and the ability to replay previous states are crucial.

### Errors as Values (lite-fp)

Fallible operations return explicit `Result` values (via [lite-fp](https://www.npmjs.com/package/lite-fp)) — no hidden
promise rejections, no try-catch sprawl. Failure modes are typed strings you can switch on:

```typescript
import { isDone, isFail, err, val } from 'lite-fp';

const mach = new_mach(game, 60, 1000, { mode: 'ledger' });
const result = run(mach, game, lateAction);

if (isFail(result)) {
  switch (err(result)) {
    case 'ACTION_IN_PAST':      /* alert / reconcile */ break;
    case 'COMPUTE_BEHIND_HEAD': /* resync */           break;
  }
} else {
  const state = val(result);
}
```

- Core: `register_action` → `Result<void, MachError>`, `run` → `Result<S, MachError>`, `try_compute` never clamps silently.
- Layer2: `replay_from_snapshot` → `Result<S, Layer2Error>`, `acquire_lock` → `Result<LockToken, 'LOCK_HELD'>`, `get_snapshot_at_tick` → `Option<Snapshot>`.
- Orchestrator: every effect outcome is captured; `ExecutionReport.items[].result` carries `Done | Fail`, and only fulfilled effects enter the idempotency cache.

### Side Effects (Orchestrator)

Side effects stay out of the pure core. A generator derives effects from the `(prev, next, action)`
transition, an executor runs them, and a `seen` store provides idempotency:

```typescript
import { create_orchestrator, new_memory_store } from '@uwu-games/uwu-state-machine';

const orchestrator = create_orchestrator({
  mach, game,
  generator: (prev, next, action) => next.score > prev.score ? [{ key: `score-${action.time}` }] : [],
  executor: async (effect) => { /* HTTP, DB, messaging... */ },
  seen: new_memory_store(),
});

await orchestrator.dispatch(action); // or orchestrate with 'parallel'/'allSettled' strategies
```

### Layer2 (Immutable Log & Snapshots)

`create_layer2` wraps a machine with a hash‑chained append‑only log (SHA‑256/512), periodic snapshots,
deterministic replay from any snapshot, schema migrations, and resource locks:

```typescript
import { create_layer2 } from '@uwu-games/uwu-state-machine';

const layer2 = create_layer2(mach, game, { snapshot_interval: 100 });
layer2.register_action_with_id(action, 'unique-action-id'); // idempotent by actionId
layer2.get_chain_integrity(); // verifies hash chain
```
