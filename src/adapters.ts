import * as Mach from './main';

/**
 * Pluggable environmental seams. Everything a driver could reasonably swap
 * lives behind these interfaces; the core never reaches globals itself.
 */

/** Time source. Real clocks for production; simulated clocks make time a test input. */
export type Clock = { now_ms(): number };

export const system_clock: Clock = {
  now_ms: () => Date.now(),
};

/** Deterministic clock driven manually — reproducible timestamps for tests/backtests. */
export function simulated_clock(start_ms: number = 0): {
  clock: Clock;
  advance: (ms: number) => void;
  set: (ms: number) => void;
} {
  let now = start_ms;
  return {
    clock: { now_ms: () => now },
    advance: (ms) => { now += ms; },
    set: (ms) => { now = ms; },
  };
}

/** Hash function over canonical text. Presets live in layer2; any function fits. */
export type Hasher = (input: string) => string;

/**
 * Text codec for states/actions. Default is JSON (bigint-safe on write);
 * custom codecs unlock BigInt/Map/Set states end-to-end.
 */
export type Serializer<S, A> = {
  stringify_state(state: S): string;
  parse_state(raw: string): S;
  stringify_action(action: Mach.Action<A>): string;
  parse_action(raw: string): Mach.Action<A>;
};

const bigint_replacer = (_key: string, value: any) =>
  typeof value === 'bigint' ? value.toString() + 'n' : value;

export function json_serializer<S, A>(): Serializer<S, A> {
  return {
    stringify_state: (state) => JSON.stringify(state, bigint_replacer),
    parse_state: (raw) => JSON.parse(raw),
    stringify_action: (action) => JSON.stringify(action, bigint_replacer),
    parse_action: (raw) => JSON.parse(raw),
  };
}
