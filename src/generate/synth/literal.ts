/**
 * The ONE JavaScript-literal writer.
 *
 * The probe and the emitter must agree byte-for-byte about what a fixture's
 * arguments are. They did not: the probe serialised them with JSON.stringify,
 * which turns a Date into a string, so it called exportFilename("2020-01-15…")
 * and faithfully recorded the resulting "at.toISOString is not a function".
 * The emitter then wrote new Date("2020-01-15…"), which does not throw — and
 * eight generated tests failed against behaviour that never happened.
 *
 * JSON cannot carry Date, Infinity, -Infinity, NaN, -0, undefined or bigint.
 * JavaScript source can. So arguments and expectations both go through here,
 * and any value this cannot represent is refused rather than approximated.
 *
 * Third time a duplicated implementation has caused a silent wrong answer in
 * this codebase (the CLI's generate loop, the object walkers, now this one).
 * Shared, or it drifts.
 */
export function toJsLiteral(v: unknown, seen: unknown[] = []): string | null {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';

  const t = typeof v;

  if (t === 'number') {
    const n = v as number;
    if (Number.isNaN(n)) return 'NaN';
    if (n === Infinity) return 'Infinity';
    if (n === -Infinity) return '-Infinity';
    if (Object.is(n, -0)) return '-0';
    return String(n);
  }
  if (t === 'boolean') return String(v);
  if (t === 'string') return JSON.stringify(v);
  if (t === 'bigint') return `${String(v)}n`;
  if (t === 'function' || t === 'symbol') return null;

  if (v instanceof Date) {
    return Number.isNaN(v.getTime())
      ? 'new Date(NaN)'
      : `new Date(${JSON.stringify(v.toISOString())})`;
  }
  if (v instanceof RegExp || v instanceof Map || v instanceof Set) return null;

  if (seen.indexOf(v) !== -1) return null; // circular

  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const item of v) {
      const lit = toJsLiteral(item, seen.concat([v]));
      if (lit === null) return null;
      parts.push(lit);
    }
    return `[${parts.join(', ')}]`;
  }

  if (t === 'object') {
    const proto = Object.getPrototypeOf(v);
    // A class instance does not round-trip into an object literal faithfully.
    if (proto !== Object.prototype && proto !== null) return null;
    const parts: string[] = [];
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const lit = toJsLiteral(val, seen.concat([v]));
      if (lit === null) return null;
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
      parts.push(`${key}: ${lit}`);
    }
    return `{${parts.join(', ')}}`;
  }

  return null;
}

/** The source text of this function, so the probe can carry its own copy. */
export const TO_JS_LITERAL_SOURCE = toJsLiteral.toString();
