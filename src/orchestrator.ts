
import * as Mach from './main';


/**
 * Describes a side effect emitted by the game logic.
 *
 * The orchestrator only requires a deterministic `key` that uniquely
 * identifies the effect. Drivers should use this key to implement
 * idempotency (prevent re‑execution of the same effect). The rest of the
 * payload (`E`) is application‑defined.
 */
export type SideEffect<E> = { key: string } & E;

/**
 * Pure derivation of effects from a state transition.
 *
 * Given `prev` → `next` and the triggering `action`, compute the precise
 * list of effects to run. This function must be pure and deterministic.
 * The orchestrator ensures both `prev` and `next` are computed at the
 * same logical time boundary as the action.
 */
export type SideEffectGenerator<S, A, E> = (
  prev: S,
  next: S,
  action: Mach.Action<A>
) => SideEffect<E>[];

/**
 * Imperative runner for effects (driver‑provided).
 *
 * Encapsulates real I/O (HTTP, DB, messaging, etc). Should be safe to
 * retry; idempotency should be respected if the same effect is executed
 * more than once by accident.
 */
export type SideEffectExecutor<E> = (effect: SideEffect<E>) => Promise<void> | void;

/**
 * Optional logger used by the orchestrator. Defaults to `console`.
 */
export type Logger = {
  info?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
};

/**
 * Execution options for advanced orchestration.
 *
 * - parallel: run effects concurrently (optionally bounded by `concurrency`).
 * - allSettled: run concurrently and mark only fulfilled effects as seen.
 */
export type EffectExecOptions<E> = {
  /** Execution strategy: 'parallel' or 'allSettled' */
  strategy: 'parallel' | 'allSettled';
  /** Optional custom executor function */
  executor?: SideEffectExecutor<E>;
  /** Maximum number of concurrent executions (for parallel strategies) */
  concurrency?: number;
};

/**
 * Driver configuration for side‑effect orchestration.
 *
 * The `seen` set is an idempotency cache owned by the driver. In
 * production it should be backed by durable storage (e.g., Redis/DB)
 * so effects are not re‑run on restarts.
 */
export type SideEffectConfig<S, A, E> = {
  /** The state machine instance. */
  mach: Mach.Mach<S, A>;
  /** The core logic (pure functions). */
  game: Mach.Game<S, A>;
  /** A pure function to generate effects based on state changes (diffs). */
  generator: SideEffectGenerator<S,A, E>;
  /** The function that executes the side effects. */
  executor: SideEffectExecutor<E>;
  /** Idempotency cache used to dedupe effect keys. */
  seen: Set<string>;
  /** Optional logger implementation. */
  logger?: Logger;
};

/**
 * dispatch
 *
 * Applies one action and executes any derived side effects sequentially.
 * Effects whose keys are already recorded in `seen` are skipped. Successful
 * executions add their keys to `seen`, giving at‑least‑once delivery with
 * simple idempotency.
 */
export async function dispatch<S, A, E>(config: SideEffectConfig<S, A, E>, action: Mach.Action<A>): Promise<S> {
  const { mach, game, generator, executor, seen, logger } = config;

  // Compute deterministic states around the action.
  const prev = Mach.get_latest_state(mach);
  const next = Mach.run(mach, game, action);

  // Plan side effects from the precise transition (pure).
  const effects = generator(prev, next, action);

  // Filter unprocessed effects (pre‑execution idempotency).
  const pendingEffects = effects.filter(effect => !seen.has(effect.key));

  if (pendingEffects.length === 0) {
    return next; // Nothing to execute
  }

  // Execute effects sequentially; keeps behavior simple and predictable.
  for (const effect of pendingEffects) {
    try {
      await executor(effect);
      seen.add(effect.key);
    } catch (error) {
      // Log and continue; at‑least‑once semantics.
      (logger?.error || console.error)(`Effect execution failed for ${effect.key}:`, error);
    }
  }
  return next;
}


/**
 * orchestrate
 *
 * Like `dispatch`, but with configurable strategy and concurrency:
 *
 * - parallel: runs the whole batch concurrently (or in fixed‑size batches
 *   when `concurrency` is provided). If any item in a batch fails, the
 *   batch is not marked as seen (all‑or‑nothing per batch).
 * - allSettled: runs concurrently and marks only fulfilled effects as seen;
 *   failures are logged and can be retried later.
 */
export async function orchestrate<S, A, E>(
  config: SideEffectConfig<S, A, E>,
  action: Mach.Action<A>,
  exec: EffectExecOptions<E>
): Promise<S> {
  const { mach, game, generator, executor, seen, logger } = config;
  const effectExecutor = exec.executor || executor;
  const maxConcurrency = Math.max(1, exec.concurrency ?? 0) || undefined;

  const prev = Mach.get_latest_state(mach);
  const next = Mach.run(mach, game, action);

  const effects = generator(prev, next, action);
  const pendingEffects = effects.filter(effect => !seen.has(effect.key));

  if (pendingEffects.length === 0) {
    return next;
  }

  switch (exec.strategy) {
    case 'parallel': {
      // If no concurrency specified, run all in parallel as before
      if (!maxConcurrency || maxConcurrency >= pendingEffects.length) {
        try {
          await Promise.all(pendingEffects.map(effect => effectExecutor(effect)));
          pendingEffects.forEach(effect => seen.add(effect.key));
        } catch (error) {
          (logger?.error || console.error)('Some effects failed during parallel execution:', error);
        }
      } else {
        // Batching approach: run up to maxConcurrency at a time
        let failed = false;
        for (let i = 0; i < pendingEffects.length; i += maxConcurrency) {
          const batch = pendingEffects.slice(i, i + maxConcurrency);
          try {
            await Promise.all(batch.map(effect => effectExecutor(effect)));
          } catch (error) {
            // Do not mark any keys if any batch fails (all-or-nothing semantics)
            (logger?.error || console.error)('Some effects failed during parallel (batched) execution:', error);
            failed = true;
            break;
          }
        }
        if (!failed) {
          pendingEffects.forEach(effect => seen.add(effect.key));
        }
      }
      break;
    }

    case 'allSettled': {
      if (!maxConcurrency || maxConcurrency >= pendingEffects.length) {
        const results = await Promise.allSettled(
          pendingEffects.map(effect => effectExecutor(effect))
        );
        results.forEach((result, index) => {
          const effect = pendingEffects[index];
          if (result.status === 'fulfilled') {
            seen.add(effect.key);
          } else {
            (logger?.error || console.error)(`Effect execution failed for ${effect.key}:`, result.reason);
          }
        });
      } else {
        // Batched allSettled: settle each batch and mark successes
        for (let i = 0; i < pendingEffects.length; i += maxConcurrency) {
          const batch = pendingEffects.slice(i, i + maxConcurrency);
          const results = await Promise.allSettled(batch.map(effect => effectExecutor(effect)));
          results.forEach((result, index) => {
            const effect = batch[index]!;
            if (result.status === 'fulfilled') {
              seen.add(effect.key);
            } else {
              (logger?.error || console.error)(`Effect execution failed for ${effect.key}:`, result.reason);
            }
          });
        }
      }
      break;
    }
  }

  return next;
}
