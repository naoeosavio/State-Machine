import * as Mach from './main';
import { sha256_hex, sha512_hex } from './hash';
import { system_clock, json_serializer, type Clock, type Hasher, type Serializer } from './adapters';
import { done, fail, isFail, some, none, type Result, type Option } from 'lite-fp';

export type Hash = string;
export type ActionId = string;
export type SchemaVersion = number;
export type SnapshotId = string;
export type LockToken = string;

/**
 * Explicit failure modes of the Layer2 surface.
 * CHAIN_BROKEN is reserved for the upcoming persistence reload path.
 */
export type Layer2Error =
  | 'SNAPSHOT_NOT_FOUND'
  | 'TARGET_BEFORE_SNAPSHOT'
  | 'LOCK_HELD'
  | 'CHAIN_BROKEN';

export interface Layer2Config<S, A> {
  mach: Mach.Mach<S, A>;
  game: Mach.Game<S, A>;
  snapshot_interval: number;
  /** Preset algorithms; ignored when a custom `hasher` is provided. */
  hash_algorithm: 'sha256' | 'sha512' | 'custom';
  /** Custom hash function; takes precedence over `hash_algorithm`. */
  hasher?: Hasher;
  /** Time source; defaults to the system clock. Use a simulated clock for reproducible chains. */
  clock?: Clock;
  /** Text codec used for hashing inputs; defaults to bigint-safe JSON. */
  serializer?: Serializer<S, A>;
  schema_version: SchemaVersion;
}

export interface ImmutableLogEntry<S, A> {
  entry_id: string;
  timestamp: number;
  tick: Mach.Tick;
  action: Mach.Action<A> | null;
  state_before: S | null;
  state_after: S | null;
  hash: Hash;
  previous_hash: Hash | null;
  action_id: ActionId | null;
  schema_version: SchemaVersion;
  metadata: Record<string, any>;
}

export interface Snapshot<S> {
  snapshot_id: SnapshotId;
  timestamp: number;
  tick: Mach.Tick;
  state: S;
  hash: Hash;
  previous_snapshot_hash: Hash | null;
  log_entries_since_previous: string[];
  schema_version: SchemaVersion;
}

export interface SchemaMigration {
  from_version: SchemaVersion;
  to_version: SchemaVersion;
  migrate: (data: any) => any;
}

export interface Lock {
  token: LockToken;
  resource_id: string;
  acquired_at: number;
  expires_at: number | null;
  owner: string;
  type: 'pessimistic' | 'optimistic';
}

export class Layer2<S, A> {
  private config: Layer2Config<S, A>;
  private clock: Clock;
  private hasher: Hasher;
  private serializer: Serializer<S, A>;
  private immutable_log: ImmutableLogEntry<S, A>[] = [];
  private snapshots: Snapshot<S>[] = [];
  private schema_migrations: SchemaMigration[] = [];
  private locks: Map<string, Lock> = new Map();
  private action_id_map: Map<ActionId, string> = new Map();
  private last_hash: Hash = '0'.repeat(64);

  constructor(config: Layer2Config<S, A>) {
    this.config = config;
    this.clock = config.clock ?? system_clock;
    this.serializer = config.serializer ?? json_serializer<S, A>();
    this.hasher = config.hasher ?? this.preset_hasher(config.hash_algorithm);
    this.initialize_genesis();
  }

  /** Resolve a preset algorithm to a concrete hash function. */
  private preset_hasher(algorithm: 'sha256' | 'sha512' | 'custom'): Hasher {
    switch (algorithm) {
      case 'sha256':
        return sha256_hex;
      case 'sha512':
        return sha512_hex;
      case 'custom':
        return (input) => this.custom_hash(input);
    }
  }

  private initialize_genesis(): void {
    const now = this.clock.now_ms();
    const genesis_state = this.config.game.init();
    const genesis_hash = this.hasher('genesis|' + this.serializer.stringify_state(genesis_state));

    const genesis_snapshot: Snapshot<S> = {
      snapshot_id: 'genesis',
      timestamp: now,
      tick: 0,
      state: genesis_state,
      hash: genesis_hash,
      previous_snapshot_hash: null,
      log_entries_since_previous: [],
      schema_version: this.config.schema_version,
    };

    this.snapshots.push(genesis_snapshot);
    this.last_hash = genesis_hash;
  }

  private serialize_state(state: S): string {
    return this.serializer.stringify_state(state);
  }

  private serialize_action(action: Mach.Action<A>): string {
    return this.serializer.stringify_action(action);
  }

  private compute_hash(...inputs: string[]): Hash {
    return this.hasher(inputs.join('|'));
  }

  private custom_hash(input: string): Hash {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    
    let hash = 0n;
    for (const byte of data) {
      hash = ((hash << 8n) ^ BigInt(byte)) & ((1n << 256n) - 1n);
      hash = hash ^ (hash >> 13n);
      hash = hash * 0x9e3779b97f4a7c15n;
      hash = hash ^ (hash >> 15n);
    }
    
    return hash.toString(16).padStart(64, '0');
  }

  /**
   * Register an idempotent action and append it to the hash chain.
   * Forwards the core's failure untouched (e.g. ACTION_IN_PAST on ledger
   * machines) — nothing is computed, logged or snapshotted on failure.
   */
  public register_action_with_id(action: Mach.Action<A>, action_id: ActionId): Result<void, Mach.MachError | Layer2Error> {
    if (this.action_id_map.has(action_id)) {
      return done(undefined);
    }

    const registered = Mach.register_action(this.config.mach, action);
    if (isFail(registered)) {
      return registered;
    }

    const now = this.clock.now_ms();
    const tick = Mach.time_to_tick(this.config.mach, action.time);
    const current_state = Mach.get_latest_state(this.config.mach);
    const new_state = Mach.compute(this.config.mach, this.config.game, action.time);

    // Hash inputs are fully deterministic: same prior chain + same action
    // yields the same entry hash, id and timestamps come from the injected clock.
    const entry_hash = this.compute_hash(
      this.last_hash,
      action_id,
      this.serialize_action(action),
      this.serialize_state(current_state),
      this.serialize_state(new_state),
      tick.toString(),
    );

    const log_entry: ImmutableLogEntry<S, A> = {
      entry_id: `entry_${entry_hash.slice(0, 16)}`,
      timestamp: now,
      tick,
      action,
      state_before: current_state,
      state_after: new_state,
      hash: entry_hash,
      previous_hash: this.last_hash,
      action_id,
      schema_version: this.config.schema_version,
      metadata: {},
    };

    this.immutable_log.push(log_entry);
    this.action_id_map.set(action_id, log_entry.entry_id);
    this.last_hash = entry_hash;

    this.maybe_create_snapshot(tick);
    return done(undefined);
  }

  private maybe_create_snapshot(current_tick: Mach.Tick): void {
    const last_snapshot = this.snapshots[this.snapshots.length - 1];
    if (!last_snapshot) return;

    const ticks_since_last = current_tick - last_snapshot.tick;
    if (ticks_since_last >= this.config.snapshot_interval) {
      this.create_snapshot(current_tick);
    }
  }

  private create_snapshot(tick: Mach.Tick): void {
    const now = this.clock.now_ms();
    const time = Mach.tick_to_time(tick, this.config.mach.ticks_per_second);
    const state = Mach.get_state_at_tick(this.config.mach, tick)
      ?? Mach.compute(this.config.mach, this.config.game, time);

    const last_snapshot = this.snapshots[this.snapshots.length - 1];
    const log_entries_since = this.immutable_log
      .filter(entry => entry.tick > (last_snapshot?.tick || 0) && entry.tick <= tick)
      .map(entry => entry.entry_id);

    const snapshot_hash = this.compute_hash(
      last_snapshot?.hash || '0'.repeat(64),
      this.serialize_state(state),
      tick.toString(),
      log_entries_since.join(',')
    );

    // Id is content-addressed: same chain + state => same snapshot id.
    const snapshot: Snapshot<S> = {
      snapshot_id: `snapshot_${tick}_${snapshot_hash.slice(0, 16)}`,
      timestamp: now,
      tick,
      state,
      hash: snapshot_hash,
      previous_snapshot_hash: last_snapshot?.hash || null,
      log_entries_since_previous: log_entries_since,
      schema_version: this.config.schema_version,
    };

    this.snapshots.push(snapshot);
  }

  /** Closest snapshot at or before `tick`, as an explicit Option. */
  public get_snapshot_at_tick(tick: Mach.Tick): Option<Snapshot<S>> {
    let closest: Snapshot<S> | null = null;

    for (const snapshot of this.snapshots) {
      if (snapshot.tick <= tick && (!closest || snapshot.tick > closest.tick)) {
        closest = snapshot;
      }
    }

    return closest ? some(closest) : none();
  }

  /**
   * Deterministically rebuild state at `target_tick` by re-applying logged
   * actions on top of the snapshot through the core machine.
   */
  public replay_from_snapshot(snapshot_id: SnapshotId, target_tick: Mach.Tick): Result<S, Layer2Error> {
    const snapshot = this.snapshots.find(s => s.snapshot_id === snapshot_id);
    if (!snapshot) return fail('SNAPSHOT_NOT_FOUND');
    if (target_tick < snapshot.tick) return fail('TARGET_BEFORE_SNAPSHOT');

    const mach = this.config.mach;

    // Seed a fresh machine from the snapshot state.
    const seed: Mach.Mach<S, A> = {
      mode: mach.mode,
      ticks_per_second: mach.ticks_per_second,
      max_tick_travel: Number.MAX_SAFE_INTEGER,
      genesis_tick: snapshot.tick,
      cached_tick: snapshot.tick,
      state_logs: { [snapshot.tick]: snapshot.state },
      action_logs: {},
      last_state: snapshot.state,
    };

    // Re-register actions from the snapshot tick onward. The snapshot state
    // is pre-tick (state_logs[t] is cached before game.tick runs), so the
    // action recorded at snapshot.tick itself must be re-applied. The log is
    // append-only, hence already in deterministic order.
    for (const entry of this.immutable_log) {
      if (entry.tick >= snapshot.tick && entry.tick <= target_tick && entry.action) {
        Mach.register_action(seed, entry.action);
      }
    }

    return done(Mach.compute(seed, this.config.game, Mach.tick_to_time(target_tick, mach.ticks_per_second)));
  }

  public add_schema_migration(migration: SchemaMigration): void {
    this.schema_migrations.push(migration);
    this.schema_migrations.sort((a, b) => a.from_version - b.from_version);
  }

  public migrate_data(data: any, target_version: SchemaVersion): any {
    let current_version = data.schema_version || 1;
    
    while (current_version < target_version) {
      const migration = this.schema_migrations.find(m => m.from_version === current_version);
      if (!migration) break;
      
      data = migration.migrate(data);
      current_version = migration.to_version;
    }
    
    return data;
  }

  public acquire_lock(resource_id: string, owner: string, type: 'pessimistic' | 'optimistic', ttl_ms?: number): Result<LockToken, 'LOCK_HELD'> {
    const now = this.clock.now_ms();
    const existing_lock = this.locks.get(resource_id);

    if (existing_lock) {
      if (existing_lock.expires_at && now > existing_lock.expires_at) {
        this.locks.delete(resource_id);
      } else {
        return fail('LOCK_HELD');
      }
    }

    const token = `lock_${now}_${Math.random().toString(36).substr(2, 9)}`;
    const lock: Lock = {
      token,
      resource_id,
      acquired_at: now,
      expires_at: ttl_ms ? now + ttl_ms : null,
      owner,
      type,
    };

    this.locks.set(resource_id, lock);
    return done(token);
  }

  public release_lock(resource_id: string, token: LockToken): boolean {
    const lock = this.locks.get(resource_id);
    if (!lock || lock.token !== token) return false;

    this.locks.delete(resource_id);
    return true;
  }

  public verify_lock(resource_id: string, token: LockToken): boolean {
    const lock = this.locks.get(resource_id);
    if (!lock || lock.token !== token) return false;

    if (lock.expires_at && this.clock.now_ms() > lock.expires_at) {
      this.locks.delete(resource_id);
      return false;
    }

    return true;
  }

  public get_chain_integrity(): { valid: boolean; invalid_hashes: string[] } {
    const invalid_hashes: string[] = [];

    for (let i = 1; i < this.immutable_log.length; i++) {
      const current = this.immutable_log[i];
      const previous = this.immutable_log[i - 1];
      
      if (current.previous_hash !== previous.hash) {
        invalid_hashes.push(current.entry_id);
      }
    }

    for (let i = 1; i < this.snapshots.length; i++) {
      const current = this.snapshots[i];
      const previous = this.snapshots[i - 1];
      
      if (current.previous_snapshot_hash !== previous.hash) {
        invalid_hashes.push(current.snapshot_id);
      }
    }

    return {
      valid: invalid_hashes.length === 0,
      invalid_hashes,
    };
  }

  public export_log(): ImmutableLogEntry<S, A>[] {
    return [...this.immutable_log];
  }

  public export_snapshots(): Snapshot<S>[] {
    return [...this.snapshots];
  }

  public get_log_entry_by_action_id(action_id: ActionId): ImmutableLogEntry<S, A> | null {
    const entry_id = this.action_id_map.get(action_id);
    if (!entry_id) return null;
    
    return this.immutable_log.find(entry => entry.entry_id === entry_id) || null;
  }

  public get_metrics() {
    return {
      total_log_entries: this.immutable_log.length,
      total_snapshots: this.snapshots.length,
      last_snapshot_tick: this.snapshots[this.snapshots.length - 1]?.tick || 0,
      current_hash: this.last_hash,
      action_id_count: this.action_id_map.size,
      active_locks: this.locks.size,
      chain_integrity: this.get_chain_integrity().valid,
    };
  }
}

export function create_layer2<S, A>(
  mach: Mach.Mach<S, A>,
  game: Mach.Game<S, A>,
  options?: Partial<Omit<Layer2Config<S, A>, 'mach' | 'game'>>
): Layer2<S, A> {
  const config: Layer2Config<S, A> = {
    mach,
    game,
    snapshot_interval: options?.snapshot_interval || 1000,
    hash_algorithm: options?.hash_algorithm || 'sha256',
    hasher: options?.hasher,
    clock: options?.clock,
    serializer: options?.serializer,
    schema_version: options?.schema_version || 1,
  };

  return new Layer2(config);
}