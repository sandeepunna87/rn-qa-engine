import { Node, SourceFile, SyntaxKind, Type } from 'ts-morph';

/**
 * Turns a TypeScript type into a set of concrete candidate values.
 *
 * This is the step that makes a no-model generator viable for TypeScript.
 * Search-based generators (Diffblue, EvoSuite) exist because Java's `String
 * tier` tells you nothing, so they must SEARCH for inputs that reach each
 * branch. TypeScript hands the answer over:
 *
 *   tier: 'trial' | 'free' | 'pro' | 'enterprise'   -> four cases, enumerated
 *   isVerified: boolean                              -> two
 *   units: number                                    -> boundaries from the body
 *
 * The type system does the work the search algorithm exists to do.
 */

export interface Candidate {
  /** JS value, embedded into the generated test as a literal. */
  value: unknown;
  /** Short label used in the test name, e.g. tier=pro. */
  label: string;
}

const MAX_CANDIDATES_PER_PARAM = 8;

/**
 * Built-ins that need constructing, not walking. Two fixed dates rather than
 * `new Date()` — a generated test whose expectation depends on when it ran is
 * a flaky test, and characterization tests are meant to be reproducible.
 */
const BUILTIN_VALUES: Record<string, () => unknown[]> = {
  Date: () => [new Date('2026-04-01T00:00:00.000Z'), new Date('2020-01-15T12:30:00.000Z')],
};

/** Built-ins with no sensible literal form — better no fixture than a wrong one. */
const OPAQUE_BUILTINS = new Set([
  'RegExp',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'Error',
  'Function',
  'Symbol',
  'ArrayBuffer',
  'Buffer',
]);
const MAX_OBJECT_DEPTH = 3;

function lit(value: unknown): string {
  if (typeof value === 'string') return value === '' ? "''" : value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[${value.length}]`;
  if (typeof value === 'object') return '{…}';
  return String(value);
}

/**
 * Every numeric literal in the file, used as boundary candidates.
 *
 * Deliberately blunt. Tracing `limit.min` back through `LIMITS[req.tier]`
 * needs dataflow analysis; collecting the constants the file actually
 * mentions gets the same branch arms for a fraction of the complexity. For a
 * quota policy that means 0, 1, 100, 500, 1000, 50000, 1000000 — which is
 * exactly the set its comparisons turn on.
 */
export function numericLiteralsIn(sf: SourceFile): number[] {
  const seen = new Set<number>();
  for (const n of sf.getDescendantsOfKind(SyntaxKind.NumericLiteral)) {
    const v = Number(n.getText());
    if (Number.isFinite(v)) seen.add(v);
  }
  return [...seen].sort((a, b) => a - b);
}

/** String literals the file compares against — 'INR', 'pro', a status code. */
export function stringLiteralsIn(sf: SourceFile): string[] {
  const seen = new Set<string>();
  for (const n of sf.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    const v = n.getLiteralValue();
    // Import specifiers and long prose are noise, not test inputs.
    if (v.length > 0 && v.length <= 40 && !v.includes('/') && !v.includes(' ')) seen.add(v);
  }
  return [...seen];
}

/**
 * Boundary triples around each constant: n-1, n, n+1.
 *
 * A comparison `units > 500` is only exercised by testing both sides of 500,
 * and off-by-one bugs live precisely at 500 itself.
 */
function boundaryValues(constants: number[], cap: number): number[] {
  const out = new Set<number>([0]);
  for (const c of constants) {
    out.add(c);
    out.add(c + 1);
    if (c > 0) out.add(c - 1);
  }

  // Sample DOWN the ascending list first — keeping the extremes and spreading
  // the rest — because that sampling depends on the ordering. Reordering
  // before sampling silently drops the high boundaries that drive the
  // "above maximum" arms, which cost 4pp of branch coverage when I got this
  // the wrong way round.
  const ascending = [...out].sort((a, b) => a - b);
  let kept: number[];
  if (ascending.length <= cap) {
    kept = ascending;
  } else {
    const step = ascending.length / cap;
    const picked = new Set<number>([ascending[0], ascending[ascending.length - 1]]);
    for (let i = 0; picked.size < cap && i < ascending.length; i += step) {
      picked.add(ascending[Math.floor(i)]);
    }
    kept = [...picked].sort((a, b) => a - b);
  }

  // Only now lead with the smallest positive value, so the base fixture is a
  // plausible input rather than 0 tripping the function's own guard clause.
  const firstPositive = kept.find((n) => n > 0);
  return firstPositive === undefined
    ? kept
    : [firstPositive, ...kept.filter((n) => n !== firstPositive)];
}

export interface DeriveContext {
  sf: SourceFile;
  /** Node used to resolve property types. */
  at: Node;
  numbers: number[];
  strings: string[];
}

export function deriveCandidates(
  type: Type,
  name: string,
  ctx: DeriveContext,
  depth = 0
): Candidate[] {
  const label = (v: unknown): string => `${name}=${lit(v)}`;
  const wrap = (values: unknown[]): Candidate[] =>
    values.slice(0, MAX_CANDIDATES_PER_PARAM).map((value) => ({ value, label: label(value) }));

  // --- literal types: the type IS the test case -----------------------------
  if (type.isStringLiteral() || type.isNumberLiteral()) {
    return wrap([type.getLiteralValue()]);
  }
  if (type.isBooleanLiteral()) {
    return wrap([type.getText() === 'true']);
  }

  // --- unions: enumerate every member --------------------------------------
  if (type.isUnion()) {
    const members = type.getUnionTypes();
    // ts-morph models `boolean` as `true | false`; treat it as one thing.
    const isPlainBoolean =
      members.length === 2 && members.every((m) => m.isBooleanLiteral());
    if (isPlainBoolean) return wrap([true, false]);

    const out: Candidate[] = [];
    for (const m of members) {
      if (m.isUndefined()) {
        out.push({ value: undefined, label: label(undefined) });
        continue;
      }
      if (m.isNull()) {
        out.push({ value: null, label: label(null) });
        continue;
      }
      out.push(...deriveCandidates(m, name, ctx, depth + 1));
      if (out.length >= MAX_CANDIDATES_PER_PARAM) break;
    }
    return out.slice(0, MAX_CANDIDATES_PER_PARAM);
  }

  // --- primitives -----------------------------------------------------------
  if (type.isBoolean()) return wrap([true, false]);

  if (type.isNumber()) {
    return wrap(boundaryValues(ctx.numbers, MAX_CANDIDATES_PER_PARAM));
  }

  if (type.isString()) {
    // Order matters: the FIRST candidate becomes the base fixture that every
    // other variant is built from, so it has to be a plausible value. Leading
    // with '' made every base case fail its own guard clause
    // (`!id || id.trim().length === 0`), which made the variants meaningless.
    // Empty and whitespace still follow, because both arms of that guard need
    // driving.
    return wrap([`${name}-1`, '', '   ', ...ctx.strings.slice(0, 3)]);
  }

  // --- arrays: empty and non-empty are almost always distinct branches ------
  if (type.isArray()) {
    const elem = type.getArrayElementType();
    const one = elem ? deriveCandidates(elem, `${name}[0]`, ctx, depth + 1)[0]?.value : undefined;
    return [
      { value: [], label: `${name}=[]` },
      { value: one === undefined ? [0] : [one], label: `${name}=[1]` },
    ];
  }

  // --- functions and callbacks: nothing honest to synthesise ----------------
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
    return [];
  }

  // --- built-ins and class instances: NEVER walk their properties -----------
  // A `Date` parameter got expanded into an object literal assembled from
  // Date's own methods — getTime, toLocaleString, each becoming {} — producing
  // twelve type errors and no usable fixture. A class instance is not a bag of
  // fields; it has to be constructed, or left alone.
  // Match on the symbol AND on the printed type: a parameter written
  // `now = new Date()` has its type inferred, and the symbol lookup misses it.
  const symbolName = type.getSymbol()?.getName() ?? type.getAliasSymbol()?.getName() ?? '';
  const typeText = type.getText().replace(/<.*$/, '').trim();
  const builtin = BUILTIN_VALUES[symbolName] ?? BUILTIN_VALUES[typeText];
  if (builtin) return wrap(builtin());
  if (OPAQUE_BUILTINS.has(symbolName) || OPAQUE_BUILTINS.has(typeText)) return [];

  // --- objects: build one from its properties -------------------------------
  if (type.isObject() && depth < MAX_OBJECT_DEPTH) {
    const props = type.getProperties();
    if (props.length === 0) return wrap([{}]);

    const built: Record<string, unknown> = {};
    for (const prop of props) {
      let propType: Type;
      try {
        propType = prop.getTypeAtLocation(ctx.at);
      } catch {
        continue;
      }
      // Methods are behaviour, not data. Including them is what broke Date.
      if (propType.getCallSignatures().length > 0) continue;

      const optional = prop.isOptional?.() ?? false;
      const cands = deriveCandidates(propType, prop.getName(), ctx, depth + 1);
      const first = cands.find((c) => c.value !== undefined);
      if (first) built[prop.getName()] = first.value;
      else if (!optional) built[prop.getName()] = null;
    }

    // A type whose every property is a method is behaviour, not data — a class
    // instance the naming check did not recognise. Emitting {} for it produces
    // an argument the compiler rejects, so produce nothing instead.
    if (Object.keys(built).length === 0) return [];

    return [{ value: built, label: `${name}={…}` }];
  }

  // Unknown / any / function / class — no honest candidate.
  return [];
}

/**
 * For an object parameter, produce one variant per property value so each
 * field's branches get driven independently rather than all at once.
 */
export function objectVariants(
  type: Type,
  name: string,
  ctx: DeriveContext
): {
  base: Record<string, unknown>;
  variants: { value: Record<string, unknown>; label: string }[];
  candidatesByProp: Map<string, Candidate[]>;
} | null {
  if (!type.isObject() || type.isArray()) return null;
  const props = type.getProperties();
  if (props.length === 0) return null;

  const base: Record<string, unknown> = {};
  const perProp: { prop: string; cands: Candidate[] }[] = [];
  const candidatesByProp = new Map<string, Candidate[]>();

  for (const prop of props) {
    let propType: Type;
    try {
      propType = prop.getTypeAtLocation(ctx.at);
    } catch {
      continue;
    }
    const cands = deriveCandidates(propType, prop.getName(), ctx, 1);
    if (cands.length === 0) continue;
    candidatesByProp.set(prop.getName(), cands);
    const optional = prop.isOptional?.() ?? false;
    if (optional) {
      // Absent in the base, present in the variants — both arms of the guard.
      perProp.push({ prop: prop.getName(), cands });
      continue;
    }
    const first = cands.find((c) => c.value !== undefined) ?? cands[0];
    base[prop.getName()] = first.value;
    if (cands.length > 1) perProp.push({ prop: prop.getName(), cands });
  }

  const variants: { value: Record<string, unknown>; label: string }[] = [];
  for (const { prop, cands } of perProp) {
    for (const c of cands) {
      if (c.value === base[prop]) continue;
      variants.push({ value: { ...base, [prop]: c.value }, label: `${prop}=${lit(c.value)}` });
    }
  }

  return { base, variants, candidatesByProp };
}

export { lit as labelValue };


/**
 * Property names that appear together inside one && or || expression.
 *
 * Varying one input at a time never drives a branch that needs two conditions
 * true at once: `region !== 'global' && tier !== 'enterprise'` stays on the
 * same arm however many single-field variants you emit. Measured on the
 * fixture, this was the whole gap between 87% and 100% branch coverage.
 *
 * So: find the conjunctions, and pair exactly those fields.
 */
export function coOccurringFields(node: Node): [string, string][] {
  const pairs = new Set<string>();

  const namesIn = (n: Node): string[] => {
    const out = new Set<string>();
    for (const id of n.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const name = id.getText();
      // Property accesses read as `req.tier` — the last segment is the field.
      if (/^[a-z][A-Za-z0-9_]*$/.test(name)) out.add(name);
    }
    return [...out];
  };

  for (const bin of node.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const op = bin.getOperatorToken().getKind();
    if (op !== SyntaxKind.AmpersandAmpersandToken && op !== SyntaxKind.BarBarToken) continue;
    const left = namesIn(bin.getLeft());
    const right = namesIn(bin.getRight());
    for (const a of left) {
      for (const b of right) {
        if (a === b) continue;
        pairs.add([a, b].sort().join('\u0000'));
      }
    }
  }

  return [...pairs].map((k) => k.split('\u0000') as [string, string]);
}
