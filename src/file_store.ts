import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { EffectStore } from './orchestrator';

type OpLine = { op: 'add' | 'del'; key: string };

/**
 * Durable EffectStore backed by an append-only JSONL file.
 *
 * - `add` appends {"op":"add","key":...}
 * - `delete` appends a tombstone {"op":"del","key":...}
 * - Reopening replays the file, so idempotency survives restarts.
 *
 * Synchronous I/O by design: effect dispatch is already async at the driver
 * level, and durability here must not depend on pending event-loop ticks.
 */
export function new_file_store(path: string): EffectStore {
  const keys = new Set<string>();

  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const op = JSON.parse(line) as OpLine;
      if (op.op === 'add') keys.add(op.key);
      else keys.delete(op.key);
    }
  }

  const append = (op: OpLine) => appendFileSync(path, JSON.stringify(op) + '\n');

  return {
    has: (k) => keys.has(k),
    add: (k) => {
      if (!keys.has(k)) {
        keys.add(k);
        append({ op: 'add', key: k });
      }
    },
    delete: (k) => {
      if (keys.delete(k)) {
        append({ op: 'del', key: k });
      }
    },
    clear: () => {
      keys.clear();
      writeFileSync(path, '');
    },
    size: () => keys.size,
  };
}
