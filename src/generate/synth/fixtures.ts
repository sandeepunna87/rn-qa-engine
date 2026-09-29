import { FunctionDeclaration, Node, SourceFile, SyntaxKind, VariableDeclaration } from 'ts-morph';
import {
  Candidate,
  coOccurringFields,
  DeriveContext,
  deriveCandidates,
  numericLiteralsIn,
  objectVariants,
  stringLiteralsIn,
} from './derive';

export interface Fixture {
  id: string;
  fnName: string;
  args: unknown[];
  /** Human-readable, becomes the test name. */
  label: string;
}

export interface FunctionTarget {
  name: string;
  node: FunctionDeclaration | VariableDeclaration;
  paramNames: string[];
}

const MAX_FIXTURES_PER_FN = 45;

/** Exported functions we can call. Components and classes are out of scope for stage 1. */
export function findFunctionTargets(sf: SourceFile): FunctionTarget[] {
  const out: FunctionTarget[] = [];

  for (const [name, decls] of sf.getExportedDeclarations()) {
    for (const d of decls) {
      if (Node.isFunctionDeclaration(d)) {
        // A function returning JSX is a component — stage 2 territory.
        const hasJsx =
          d.getDescendantsOfKind(SyntaxKind.JsxElement).length > 0 ||
          d.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement).length > 0 ||
          d.getDescendantsOfKind(SyntaxKind.JsxFragment).length > 0;
        if (hasJsx) continue;
        out.push({ name, node: d, paramNames: d.getParameters().map((p) => p.getName()) });
      } else if (Node.isVariableDeclaration(d)) {
        const init = d.getInitializer();
        if (!init) continue;
        if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue;
        const hasJsx =
          init.getDescendantsOfKind(SyntaxKind.JsxElement).length > 0 ||
          init.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement).length > 0 ||
          init.getDescendantsOfKind(SyntaxKind.JsxFragment).length > 0;
        if (hasJsx) continue;
        out.push({ name, node: d, paramNames: init.getParameters().map((p) => p.getName()) });
      }
    }
  }
  return out;
}

function parametersOf(target: FunctionTarget): { name: string; type: import('ts-morph').Type; optional: boolean }[] {
  const node = target.node;
  if (Node.isFunctionDeclaration(node)) {
    return node.getParameters().map((p) => ({
      name: p.getName(),
      type: p.getType(),
      optional: p.isOptional(),
    }));
  }
  const init = (node as VariableDeclaration).getInitializer();
  if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
    return init.getParameters().map((p) => ({
      name: p.getName(),
      type: p.getType(),
      optional: p.isOptional(),
    }));
  }
  return [];
}

/**
 * One-factor-at-a-time, not a full cartesian product.
 *
 * Four params with five candidates each is 625 combinations — minutes of test
 * runtime for coverage a few dozen cases already reach. Varying one input from
 * a known-good base is what actually drives distinct branches, and it keeps
 * each failure attributable to one input.
 */
export function buildFixtures(sf: SourceFile, target: FunctionTarget): Fixture[] {
  const params = parametersOf(target);
  if (params.length === 0) {
    return [{ id: `${target.name}#0`, fnName: target.name, args: [], label: `${target.name}()` }];
  }

  const ctx: DeriveContext = {
    sf,
    at: target.node,
    numbers: numericLiteralsIn(sf),
    strings: stringLiteralsIn(sf),
  };

  const pairs = coOccurringFields(target.node);
  const perParam: { base: unknown; variants: { value: unknown; label: string }[] }[] = [];
  const objectCandidates: (Map<string, Candidate[]> | null)[] = [];

  for (const p of params) {
    const objV = objectVariants(p.type, p.name, ctx);
    if (objV) {
      perParam.push({ base: objV.base, variants: objV.variants });
      objectCandidates.push(objV.candidatesByProp);
      continue;
    }
    objectCandidates.push(null);
    const cands: Candidate[] = deriveCandidates(p.type, p.name, ctx);
    if (cands.length === 0) {
      // Nothing derivable (any, a callback, a class). Use undefined and let the
      // probe tell us whether the function tolerates it.
      perParam.push({ base: undefined, variants: [] });
      continue;
    }
    const base = cands.find((c) => c.value !== undefined) ?? cands[0];
    perParam.push({
      base: base.value,
      variants: cands.filter((c) => c !== base).map((c) => ({ value: c.value, label: c.label })),
    });
  }

  const baseArgs = perParam.map((p) => p.base);
  const fixtures: Fixture[] = [
    { id: `${target.name}#0`, fnName: target.name, args: baseArgs, label: `${target.name} base case` },
  ];

  let n = 1;
  outer: for (let i = 0; i < perParam.length; i++) {
    for (const v of perParam[i].variants) {
      const args = [...baseArgs];
      args[i] = v.value;
      fixtures.push({
        id: `${target.name}#${n}`,
        fnName: target.name,
        args,
        label: `${target.name} ${v.label}`,
      });
      n++;
      if (fixtures.length >= MAX_FIXTURES_PER_FN) break outer;
    }
  }

  // Pair fixtures: vary two co-occurring fields at once, for the branches that
  // single-field variation structurally cannot reach.
  outerPair: for (let i = 0; i < perParam.length; i++) {
    const byProp = objectCandidates[i];
    if (!byProp) continue;
    const baseObj = perParam[i].base as Record<string, unknown> | undefined;
    if (!baseObj || typeof baseObj !== 'object') continue;

    for (const [a, b] of pairs) {
      const ca = byProp.get(a);
      const cb = byProp.get(b);
      if (!ca || !cb) continue;
      for (const va of ca.slice(0, 3)) {
        for (const vb of cb.slice(0, 3)) {
          if (va.value === baseObj[a] && vb.value === baseObj[b]) continue;
          const args = [...baseArgs];
          args[i] = { ...baseObj, [a]: va.value, [b]: vb.value };
          fixtures.push({
            id: `${target.name}#${n}`,
            fnName: target.name,
            args,
            label: `${target.name} ${va.label} ${vb.label}`,
          });
          n++;
          if (fixtures.length >= MAX_FIXTURES_PER_FN) break outerPair;
        }
      }
    }
  }

  return fixtures;
}
