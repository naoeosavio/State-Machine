
import * as Mach from './main';

/**
 * A unique identifier for events and effects.
 */
export type Id = string;

/**
 * Represents a side effect to be executed.
 * @template E The specific type of the effect payload.
 */
export type SideEffect<E> = { $: string; key: Id; payload: E };

/**
 * A function that generates a list of effects based on the transition
 * from an old state to a new state.
 * @template S The type of the state.
 * @template E The type of the effect.
 * @param oldState The state before the action was applied.
 * @param newState The state after the action was applied.
 * @returns An array of identifiable effects.
 */
export type SideEffectGenerator<S, E> = (oldState: S, newState: S) => SideEffect<E>[];

/**
 * A function that executes a given effect.
 * This is where the actual side effect logic resides (e.g., sending an email).
 * @template E The specific type of the effect payload.
 */
export type SideEffectExecutor<E> = (effect: SideEffect<E>) => Promise<void>;

/**
 * Configuration for side-effect orchestration.
 * @template S The type of the state.
 * @template A The type of the action.
 * @template E The type of the effect.
 */
export type SideEffectConfig<S, A, E> = {
  /** The state machine instance. */
  mach: Mach.Mach<S, A>;
  /** The core logic (pure functions). */
  game: Mach.Game<S, A>;
  /** A pure function to generate effects based on state changes (diffs). */
  generator: SideEffectGenerator<S, E>;
  /** The function that executes the side effects. */
  executor: SideEffectExecutor<E>;
  /** A cache to track processed effect Ids for idempotency.
   *  For production, a persistent store like Redis or a database is recommended.
   */
  idempotencyCache: Set<Id>;
};

/**
 * A generic driver function that processes an action, updates the state,
 * and orchestrates side effects with idempotency.
 *
 * @param config The driver configuration.
 * @param action The action to process.
 * @returns The new state.
 */
export async function dispatch_action<S, A, E>(config: SideEffectConfig<S, A, E>, action: Mach.Action<A>): Promise<S> {
  const { mach, game, generator, executor, idempotencyCache } = config;

  // Compute the state up to the action time BEFORE registering the action.
  // This ensures "prev" reflects the exact pre-action state at that tick,
  // avoiding diffs that include unrelated tick progression.
  const prev = Mach.compute(mach, game, action.time);

  // Apply the action and compute the resulting state at the same time boundary.
  const next = Mach.run(mach, game, action);

  // Plan side effects based on the precise state transition (pure).
  const effects = generator(prev, next);

  // Filters unprocessed effects (idempotence before execution)
  const pendingEffects = effects.filter(effect => !idempotencyCache.has(effect.key));

  if (pendingEffects.length === 0) {
    return next; // Nothing to execute
  }

  // Execute effects with an idempotency guard (sequential, simple)
  for (const effect of pendingEffects) {
    try {
      await executor(effect);
      idempotencyCache.add(effect.key);
    } catch (error) {
      // Log and continue; at-least-once semantics
      console.error(`Effect execution failed for ${effect.$}:`, error);
    }
  }
  return next;
}
