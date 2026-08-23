/**
 * Deterministic fixed-point math over BigInt.
 *
 * A `Fixed` number is an integer `value` scaled by 10^`decimals`
 * (e.g. `create_fixed("25.75", 2)` => `{ value: 2575n, decimals: 2 }`).
 *
 * All operations are exact: no floating point is ever involved, so results
 * are bit-for-bit reproducible across platforms.
 */

export type Fixed = {
  value: bigint;
  decimals: number;
};

const DIGITS = /^[0-9]+$/;

/** Parse a decimal string ("123.456", "-0.5") into a Fixed with `decimals` places. */
export function create_fixed(input: string, decimals: number): Fixed {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("decimals must be a non-negative integer.");
  }

  const text = input.trim();
  const negative = text.startsWith("-");
  const unsigned = negative || text.startsWith("+") ? text.slice(1) : text;

  const [int_part = "", frac_part = ""] = unsigned.split(".");
  if (!DIGITS.test(int_part) || (frac_part !== "" && !DIGITS.test(frac_part))) {
    throw new Error(`Invalid fixed-point literal: ${input}`);
  }

  // Pad or truncate the fractional part to exactly `decimals` digits.
  const scaled_frac = (frac_part + "0".repeat(decimals)).slice(0, decimals);
  let value = BigInt(int_part + scaled_frac);
  if (negative) value = -value;

  return { value, decimals };
}

/** Bring two Fixed numbers to a common (max) scale. */
function align(a: Fixed, b: Fixed): [Fixed, Fixed] {
  const decimals = Math.max(a.decimals, b.decimals);
  return [rescale(a, decimals), rescale(b, decimals)];
}

/** Re-scale a Fixed to a different number of decimal places (exact when widening). */
export function rescale(f: Fixed, decimals: number): Fixed {
  const diff = decimals - f.decimals;
  if (diff === 0) return f;
  if (diff < 0) {
    throw new Error("Narrowing rescale would lose precision; use truncation explicitly.");
  }
  return { value: f.value * 10n ** BigInt(diff), decimals };
}

export function add(a: Fixed, b: Fixed): Fixed {
  const [x, y] = align(a, b);
  return { value: x.value + y.value, decimals: x.decimals };
}

export function subtract(a: Fixed, b: Fixed): Fixed {
  const [x, y] = align(a, b);
  return { value: x.value - y.value, decimals: x.decimals };
}

/** Exact multiplication; scales add up (2 decimals * 1 decimals => 3 decimals). */
export function multiply(a: Fixed, b: Fixed): Fixed {
  return { value: a.value * b.value, decimals: a.decimals + b.decimals };
}

/** Render a Fixed as a plain decimal string. */
export function to_string(f: Fixed): string {
  const sign = f.value < 0n ? "-" : "";
  const digits = (f.value < 0n ? -f.value : f.value).toString().padStart(f.decimals + 1, "0");
  if (f.decimals === 0) return sign + digits;
  const int_part = digits.slice(0, -f.decimals);
  const frac_part = digits.slice(-f.decimals);
  return `${sign}${int_part}.${frac_part}`;
}
