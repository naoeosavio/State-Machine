
import * as Mach from './main';
import { done, fail, isDone, isFail, err, val, type Result } from 'lite-fp';

/**
 * Captures an async effect outcome as an explicit Result instead of letting
 * rejections escape into hidden promise state.
 */
async function attempt_effect<E>(executor: SideEffectExecutor<E>, effect: SideEffect<E>): Promise<Result<true, unknown>> {
  try {
    await executor(effect);
    return done(true);
  } catch (error) {
    return fail(error);
  }
}


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
  /** Idempotency cache used to dedupe effect keys. Swap in a durable EffectStore for restart-safe delivery. */
  seen: EffectStore;
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
  /** Present for attempted effects: Done on success, Fail carrying the error. */
  result?: Result<true, unknown>;
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
 * Effects whose keys are already recorded in `seen` are skipped. Only `Done`
 * outcomes mark their keys in `seen` — at-least-once delivery with explicit
 * per-effect results. Core failures (e.g. ACTION_IN_PAST) short-circuit as
 * Err before any effect runs.
 */
export async function dispatch<S, A, E>(config: SideEffectConfig<S, A, E>, action: Mach.Action<A>): Promise<Result<S, Mach.MachError>> {
  const { mach, game, generator, executor, seen, logger } = config;

  // Compute deterministic states around the action.
  const prev = Mach.get_latest_state(mach);
  const next_result = Mach.run(mach, game, action);
  if (isFail(next_result)) {
    return next_result;
  }
  const next = val(next_result);

  // Plan side effects from the precise transition (pure).
  const effects = generator(prev, next, action);

  // Filter unprocessed effects (pre‑execution idempotency).
  const pendingEffects = effects.filter(effect => !seen.has(effect.key));

  if (pendingEffects.length === 0) {
    return done(next); // Nothing to execute
  }

  // Execute effects sequentially with explicit outcome capture.
  for (const effect of pendingEffects) {
    const outcome = await attempt_effect(executor, effect);
    if (isDone(outcome)) {
      seen.add(effect.key);
    } else {
      // Log and continue; at‑least‑once semantics.
      (logger?.error || console.error)(`Effect execution failed for ${effect.key}:`, err(outcome));
    }
  }
  return done(next);
}


/**
 * orchestrate
 *
 * Like dispatch, but with configurable strategy and concurrency:
 *
 * - parallel: runs the whole batch concurrently (or fixed-size batches when
 *   `concurrency` is provided).
 * - allSettled: identical outcome capture; kept for API compatibility.
 *
 * In both strategies every effect outcome is captured as a Result and ONLY
 * fulfilled effects are marked in `seen`; failures are logged for retry.
 */
export async function orchestrate<S, A, E>(
  config: SideEffectConfig<S, A, E>,
  action: Mach.Action<A>,
  exec: EffectExecOptions<E>
): Promise<Result<S, Mach.MachError>> {
  const { mach, game, generator, executor, seen, logger } = config;
  const effectExecutor = exec.executor || executor;
  const maxConcurrency = Math.max(1, exec.concurrency ?? 0) || undefined;

  const prev = Mach.get_latest_state(mach);
  const next_result = Mach.run(mach, game, action);
  if (isFail(next_result)) {
    return next_result;
  }
  const next = val(next_result);

  const effects = generator(prev, next, action);
  const pendingEffects = effects.filter(effect => !seen.has(effect.key));

  if (pendingEffects.length === 0) {
    return done(next);
  }

  const run_batch = async (batch: SideEffect<E>[]) => {
    const outcomes = await Promise.all(batch.map(effect => attempt_effect(effectExecutor, effect)));
    outcomes.forEach((outcome, index) => {
      const effect = batch[index]!;
      if (isDone(outcome)) {
        seen.add(effect.key);
      } else {
        (logger?.error || console.error)(`Effect execution failed for ${effect.key}:`, err(outcome));
      }
    });
  };

  switch (exec.strategy) {
    case 'parallel':
    case 'allSettled': {
      if (!maxConcurrency || maxConcurrency >= pendingEffects.length) {
        await run_batch(pendingEffects);
      } else {
        for (let i = 0; i < pendingEffects.length; i += maxConcurrency) {
          await run_batch(pendingEffects.slice(i, i + maxConcurrency));
        }
      }
      break;
    }
  }

  return done(next);
}

/**
 * dispatch_with_report
 *
 * Sequential execution with a detailed per-effect report; every attempted
 * effect carries its explicit Result in `items`.
 */
export async function dispatch_with_report<S, A, E>(
  config: SideEffectConfig<S, A, E>,
  action: Mach.Action<A>
): Promise<Result<{ state: S; report: ExecutionReport<E> }, Mach.MachError>> {
  const { mach, game, generator, executor, seen, logger } = config;
  const prev = Mach.get_latest_state(mach);
  const next_result = Mach.run(mach, game, action);
  if (isFail(next_result)) {
    return next_result;
  }
  const next = val(next_result);

  const effects = generator(prev, next, action);
  const items: EffectExecution<E>[] = [];
  for (const effect of effects) {
    if (seen.has(effect.key)) {
      items.push({ effect, status: 'skipped' });
      continue;
    }
    const outcome = await attempt_effect(executor, effect);
    if (isDone(outcome)) {
      seen.add(effect.key);
      items.push({ effect, status: 'executed', result: outcome });
    } else {
      (logger?.error || console.error)(`Effect execution failed for ${effect.key}:`, err(outcome));
      items.push({ effect, status: 'failed', error: err(outcome), result: outcome });
    }
  }

  const report: ExecutionReport<E> = {
    total: effects.length,
    executed: items.filter(i => i.status === 'executed').length,
    skipped: items.filter(i => i.status === 'skipped').length,
    failed: items.filter(i => i.status === 'failed').length,
    items,
  };

  return done({ state: next, report });
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
): Promise<Result<{ state: S; report: ExecutionReport<E> }, Mach.MachError>> {
  const { mach, game, generator, executor, seen, logger } = config;
  const effectExecutor = exec.executor || executor;
  const maxConcurrency = Math.max(1, exec.concurrency ?? 0) || undefined;

  const prev = Mach.get_latest_state(mach);
  const next_result = Mach.run(mach, game, action);
  if (isFail(next_result)) {
    return next_result;
  }
  const next = val(next_result);

  const effects = generator(prev, next, action);
  const pending = effects.filter(e => !seen.has(e.key));

  const items: EffectExecution<E>[] = [];
  // mark pre-known skipped
  for (const e of effects) {
    if (seen.has(e.key)) items.push({ effect: e, status: 'skipped' });
  }

  if (pending.length === 0) {
    return done({
      state: next,
      report: {
        total: effects.length,
        executed: 0,
        skipped: items.length,
        failed: 0,
        items,
      },
    });
  }

  const record_batch = async (batch: SideEffect<E>[]) => {
    const outcomes = await Promise.all(batch.map(effect => attempt_effect(effectExecutor, effect)));
    outcomes.forEach((outcome, index) => {
      const e = batch[index]!;
      if (isDone(outcome)) {
        seen.add(e.key);
        items.push({ effect: e, status: 'executed', result: outcome });
      } else {
        (logger?.error || console.error)(`Effect execution failed for ${e.key}:`, err(outcome));
        items.push({ effect: e, status: 'failed', error: err(outcome), result: outcome });
      }
    });
  };

  switch (exec.strategy) {
    case 'parallel':
    case 'allSettled': {
      if (!maxConcurrency || maxConcurrency >= pending.length) {
        await record_batch(pending);
      } else {
        for (let i = 0; i < pending.length; i += maxConcurrency) {
          await record_batch(pending.slice(i, i + maxConcurrency));
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

  return done({ state: next, report });
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
    clear_seen: () => { config.seen.clear?.(); },
    get_seen_size: () => config.seen.size?.() ?? 0,
  };
}
