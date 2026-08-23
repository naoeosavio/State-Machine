import * as Mach from './main';
import { sha256_hex, sha512_hex } from './hash';

export type Hash = string;
export type ActionId = string;
export type SchemaVersion = number;
export type SnapshotId = string;
export type LockToken = string;

export interface Layer2Config<S, A> {
  mach: Mach.Mach<S, A>;
  game: Mach.Game<S, A>;
  snapshot_interval: number;
  hash_algorithm: 'sha256' | 'sha512' | 'custom';
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
  private immutable_log: ImmutableLogEntry<S, A>[] = [];
  private snapshots: Snapshot<S>[] = [];
  private schema_migrations: SchemaMigration[] = [];
  private locks: Map<string, Lock> = new Map();
  private action_id_map: Map<ActionId, string> = new Map();
  private last_hash: Hash = '0'.repeat(64);

  constructor(config: Layer2Config<S, A>) {
    this.config = config;
    this.initialize_genesis();
  }

  private initialize_genesis(): void {
    const genesis_state = this.config.game.init();
    const genesis_hash = this.compute_hash('genesis', this.serialize_state(genesis_state));
    
    const genesis_snapshot: Snapshot<S> = {
      snapshot_id: 'genesis',
      timestamp: Date.now(),
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
    return JSON.stringify(state, (_, value) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      return value;
    });
  }

  private serialize_action(action: Mach.Action<A>): string {
    return JSON.stringify(action, (_, value) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      return value;
    });
  }

  private compute_hash(...inputs: string[]): Hash {
    const input = inputs.join('|');

    switch (this.config.hash_algorithm) {
      case 'sha256':
        return sha256_hex(input);
      case 'sha512':
        return sha512_hex(input);
      case 'custom':
        return this.custom_hash(input);
    }
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

  public register_action_with_id(action: Mach.Action<A>, action_id: ActionId): void {
    if (this.action_id_map.has(action_id)) {
      return;
    }

    const tick = Mach.time_to_tick(this.config.mach, action.time);
    const current_state = Mach.get_latest_state(this.config.mach);
    
    Mach.register_action(this.config.mach, action);
    const new_state = Mach.compute(this.config.mach, this.config.game, action.time);
    
    const entry_hash = this.compute_hash(
      this.last_hash,
      action_id,
      this.serialize_action(action),
      this.serialize_state(current_state),
      this.serialize_state(new_state),
      tick.toString(),
      Date.now().toString()
    );

    const log_entry: ImmutableLogEntry<S, A> = {
      entry_id: `entry_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
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

    const snapshot: Snapshot<S> = {
      snapshot_id: `snapshot_${tick}_${Date.now()}`,
      timestamp: Date.now(),
      tick,
      state,
      hash: snapshot_hash,
      previous_snapshot_hash: last_snapshot?.hash || null,
      log_entries_since_previous: log_entries_since,
      schema_version: this.config.schema_version,
    };

    this.snapshots.push(snapshot);
  }

  public get_snapshot_at_tick(tick: Mach.Tick): Snapshot<S> | null {
    let closest: Snapshot<S> | null = null;
    
    for (const snapshot of this.snapshots) {
      if (snapshot.tick <= tick && (!closest || snapshot.tick > closest.tick)) {
        closest = snapshot;
      }
    }
    
    return closest;
  }

  public replay_from_snapshot(snapshot_id: SnapshotId, target_tick: Mach.Tick): S | null {
    const snapshot = this.snapshots.find(s => s.snapshot_id === snapshot_id);
    if (!snapshot) return null;
    if (target_tick < snapshot.tick) return null;

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

    return Mach.compute(seed, this.config.game, Mach.tick_to_time(target_tick, mach.ticks_per_second));
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

  public acquire_lock(resource_id: string, owner: string, type: 'pessimistic' | 'optimistic', ttl_ms?: number): LockToken | null {
    const existing_lock = this.locks.get(resource_id);
    
    if (existing_lock) {
      if (existing_lock.expires_at && Date.now() > existing_lock.expires_at) {
        this.locks.delete(resource_id);
      } else {
        return null;
      }
    }

    const token = `lock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const lock: Lock = {
      token,
      resource_id,
      acquired_at: Date.now(),
      expires_at: ttl_ms ? Date.now() + ttl_ms : null,
      owner,
      type,
    };

    this.locks.set(resource_id, lock);
    return token;
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
    
    if (lock.expires_at && Date.now() > lock.expires_at) {
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
    schema_version: options?.schema_version || 1,
  };

  return new Layer2(config);
}