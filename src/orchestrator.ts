
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
 * Minimal store abstraction to allow swapping the in-memory Set with a durable backend.
 */
export type EffectStore = {
  has: (key: string) => boolean;
  add: (key: string) => void;
  delete?: (key: string) => void;
  clear?: () => void;
  size?: () => number;
};

/** Wrap a Set<string> as an EffectStore (compat helper). */
export function set_store(set: Set<string>): EffectStore {
  return {
    has: (k) => set.has(k),
    add: (k) => void set.add(k),
    delete: (k) => void set.delete(k),
    clear: () => void set.clear(),
    size: () => set.size,
  };
}

/** Create a simple in-memory store. */
export function new_memory_store(): EffectStore {
  const inner = new Set<string>();
  return set_store(inner);
}

/**
 * Detailed report for an execution run.
 */
export type EffectExecution<E> = {
  effect: SideEffect<E>;
  status: 'executed' | 'skipped' | 'failed';
  error?: unknown;
};

export type ExecutionReport<E> = {
  total: number;
  executed: number;
  skipped: number;
  failed: number;
  items: EffectExecution<E>[];
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

/**
 * dispatch_with_report
 *
 * Sequential execution with a detailed report per effect.
 */
export async function dispatch_with_report<S, A, E>(
  config: SideEffectConfig<S, A, E>,
  action: Mach.Action<A>
): Promise<{ state: S; report: ExecutionReport<E> }> {
  const { mach, game, generator, executor, seen, logger } = config;
  const prev = Mach.get_latest_state(mach);
  const next = Mach.run(mach, game, action);
  const effects = generator(prev, next, action);
  const pendingEffects = effects.filter(effect => !seen.has(effect.key));

  const items: EffectExecution<E>[] = [];
  for (const effect of effects) {
    if (seen.has(effect.key)) {
      items.push({ effect, status: 'skipped' });
      continue;
    }
    try {
      await executor(effect);
      seen.add(effect.key);
      items.push({ effect, status: 'executed' });
    } catch (error) {
      (logger?.error || console.error)(`Effect execution failed for ${effect.key}:`, error);
      items.push({ effect, status: 'failed', error });
    }
  }

  const report: ExecutionReport<E> = {
    total: effects.length,
    executed: items.filter(i => i.status === 'executed').length,
    skipped: items.filter(i => i.status === 'skipped').length,
    failed: items.filter(i => i.status === 'failed').length,
    items,
  };

  return { state: next, report };
}

/**
 * orchestrate_with_report
 *
 * Same strategies as `orchestrate` but returns a report for observability.
 */
export async function orchestrate_with_report<S, A, E>(
  config: SideEffectConfig<S, A, E>,
  action: Mach.Action<A>,
  exec: EffectExecOptions<E>
): Promise<{ state: S; report: ExecutionReport<E> }> {
  const { mach, game, generator, executor, seen, logger } = config;
  const effectExecutor = exec.executor || executor;
  const maxConcurrency = Math.max(1, exec.concurrency ?? 0) || undefined;

  const prev = Mach.get_latest_state(mach);
  const next = Mach.run(mach, game, action);
  const effects = generator(prev, next, action);
  const pending = effects.filter(e => !seen.has(e.key));

  const items: EffectExecution<E>[] = [];
  // mark pre-known skipped
  for (const e of effects) {
    if (seen.has(e.key)) items.push({ effect: e, status: 'skipped' });
  }

  if (pending.length === 0) {
    return {
      state: next,
      report: {
        total: effects.length,
        executed: 0,
        skipped: items.length,
        failed: 0,
        items,
      },
    };
  }

  const pushExecuted = (e: SideEffect<E>) => items.push({ effect: e, status: 'executed' });
  const pushFailed = (e: SideEffect<E>, error: unknown) => items.push({ effect: e, status: 'failed', error });

  switch (exec.strategy) {
    case 'parallel': {
      if (!maxConcurrency || maxConcurrency >= pending.length) {
        try {
          await Promise.all(pending.map(effectExecutor));
          pending.forEach(e => { seen.add(e.key); pushExecuted(e); });
        } catch (error) {
          (logger?.error || console.error)('Some effects failed during parallel execution:', error);
          // none marked
        }
      } else {
        let failed = false;
        for (let i = 0; i < pending.length; i += maxConcurrency) {
          const batch = pending.slice(i, i + maxConcurrency);
          try {
            await Promise.all(batch.map(effectExecutor));
          } catch (error) {
            (logger?.error || console.error)('Some effects failed during parallel (batched) execution:', error);
            failed = true;
            break;
          }
        }
        if (!failed) {
          pending.forEach(e => { seen.add(e.key); pushExecuted(e); });
        }
      }
      break;
    }
    case 'allSettled': {
      if (!maxConcurrency || maxConcurrency >= pending.length) {
        const results = await Promise.allSettled(pending.map(effectExecutor));
        results.forEach((r, i) => {
          const e = pending[i]!;
          if (r.status === 'fulfilled') {
            seen.add(e.key); pushExecuted(e);
          } else {
            (logger?.error || console.error)(`Effect execution failed for ${e.key}:`, r.reason);
            pushFailed(e, r.reason);
          }
        });
      } else {
        for (let i = 0; i < pending.length; i += maxConcurrency) {
          const batch = pending.slice(i, i + maxConcurrency);
          const results = await Promise.allSettled(batch.map(effectExecutor));
          results.forEach((r, j) => {
            const e = batch[j]!;
            if (r.status === 'fulfilled') {
              seen.add(e.key); pushExecuted(e);
            } else {
              (logger?.error || console.error)(`Effect execution failed for ${e.key}:`, r.reason);
              pushFailed(e, r.reason);
            }
          });
        }
      }
      break;
    }
  }

  const report: ExecutionReport<E> = {
    total: effects.length,
    executed: items.filter(i => i.status === 'executed').length,
    skipped: items.filter(i => i.status === 'skipped').length,
    failed: items.filter(i => i.status === 'failed').length,
    items,
  };

  return { state: next, report };
}

/**
 * create_orchestrator
 *
 * Convenience factory that binds config and exposes a small, typed API.
 */
export function create_orchestrator<S, A, E>(config: SideEffectConfig<S, A, E>) {
  return {
    dispatch: (action: Mach.Action<A>) => dispatch(config, action),
    orchestrate: (action: Mach.Action<A>, exec: EffectExecOptions<E>) => orchestrate(config, action, exec),
    dispatch_with_report: (action: Mach.Action<A>) => dispatch_with_report(config, action),
    orchestrate_with_report: (action: Mach.Action<A>, exec: EffectExecOptions<E>) => orchestrate_with_report(config, action, exec),
    preload_seen: (keys: string[]) => { keys.forEach(k => config.seen.add(k)); },
    clear_seen: () => { config.seen.clear(); },
    get_seen_size: () => config.seen.size,
  };
}
