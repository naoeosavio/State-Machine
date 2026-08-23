import { new_mach, Game, Action } from '../src/main';
import { create_layer2 } from '../src/layer2';

type BankState = {
  balances: Record<string, bigint>;
  total_supply: bigint;
};

type BankAction = 
  | { $: 'deposit', account: string, amount: bigint, time: number }
  | { $: 'withdraw', account: string, amount: bigint, time: number }
  | { $: 'transfer', from: string, to: string, amount: bigint, time: number };

const bank_game: Game<BankState, BankAction> = {
  init: () => ({ balances: {}, total_supply: 0n }),
  
  when: (action: Action<BankAction>, state: BankState) => {
    switch (action.$) {
      case 'deposit': {
        const current = state.balances[action.account] || 0n;
        return {
          balances: { ...state.balances, [action.account]: current + action.amount },
          total_supply: state.total_supply + action.amount,
        };
      }
      
      case 'withdraw': {
        const current = state.balances[action.account] || 0n;
        if (current < action.amount) {
          return state;
        }
        return {
          balances: { ...state.balances, [action.account]: current - action.amount },
          total_supply: state.total_supply - action.amount,
        };
      }
      
      case 'transfer': {
        const from_balance = state.balances[action.from] || 0n;
        const to_balance = state.balances[action.to] || 0n;
        
        if (from_balance < action.amount) {
          return state;
        }
        
        return {
          balances: {
            ...state.balances,
            [action.from]: from_balance - action.amount,
            [action.to]: to_balance + action.amount,
          },
          total_supply: state.total_supply,
        };
      }
    }
  },
  
  tick: (state: BankState) => state,
};

console.log('=== Layer 2 State Machine Example ===\n');

const mach = new_mach(bank_game, 60, 10000);
const layer2 = create_layer2(mach, bank_game, {
  snapshot_interval: 5,
  hash_algorithm: 'custom',
  schema_version: 1,
});

console.log('1. Registering actions with idempotent actionIds...');
layer2.register_action_with_id(
  { $: 'deposit', account: 'alice', amount: 1000n, time: 1000 },
  'deposit-alice-1'
);

layer2.register_action_with_id(
  { $: 'deposit', account: 'bob', amount: 500n, time: 2000 },
  'deposit-bob-1'
);

layer2.register_action_with_id(
  { $: 'transfer', from: 'alice', to: 'bob', amount: 300n, time: 3000 },
  'transfer-alice-to-bob-1'
);

console.log('2. Checking metrics...');
const metrics = layer2.get_metrics();
console.log(`   Total log entries: ${metrics.total_log_entries}`);
console.log(`   Total snapshots: ${metrics.total_snapshots}`);
console.log(`   Chain integrity: ${metrics.chain_integrity ? '✓' : '✗'}`);

console.log('\n3. Exporting and verifying log...');
const log = layer2.export_log();
console.log(`   Log has ${log.length} entries`);
for (const entry of log) {
  console.log(`   - ${entry.entry_id}: ${entry.action?.$} at tick ${entry.tick}`);
}

console.log('\n4. Testing schema migrations...');
layer2.add_schema_migration({
  from_version: 1,
  to_version: 2,
  migrate: (data) => ({
    ...data,
    metadata: { migrated_from_v1: true },
    schema_version: 2,
  }),
});

const test_data = { value: 'test', schema_version: 1 };
const migrated = layer2.migrate_data(test_data, 2);
console.log(`   Migration successful: ${migrated.metadata?.migrated_from_v1 === true}`);

console.log('\n5. Testing locking mechanisms...');
const lock_token = layer2.acquire_lock('account-alice', 'service-1', 'pessimistic', 5000);
console.log(`   Acquired lock: ${lock_token ? '✓' : '✗'}`);

if (lock_token) {
  const verified = layer2.verify_lock('account-alice', lock_token);
  console.log(`   Lock verified: ${verified ? '✓' : '✗'}`);
  
  const released = layer2.release_lock('account-alice', lock_token);
  console.log(`   Lock released: ${released ? '✓' : '✗'}`);
}

console.log('\n6. Replaying from snapshot...');
const snapshots = layer2.export_snapshots();
if (snapshots.length > 1) {
  const snapshot = snapshots[1];
  const replayed = layer2.replay_from_snapshot(snapshot.snapshot_id, snapshot.tick + 2);
  console.log(`   Replayed state exists: ${replayed ? '✓' : '✗'}`);
}

console.log('\n=== Example Complete ===');
console.log('\nLayer 2 Features Implemented:');
console.log('✓ Snapshot incremental system');
console.log('✓ Append-only immutable log');
console.log('✓ Schema versioning');
console.log('✓ Idempotency via actionId');
console.log('✓ Chained hash system (blockchain-style)');
console.log('✓ Native BigInt money balances');
console.log('✓ Pessimistic/optimistic locking');