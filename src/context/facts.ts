import * as fs from 'fs';
import * as path from 'path';
import { Project, SourceFile, SyntaxKind, Node } from 'ts-morph';
import { FileFacts } from '../types';

/**
 * Native/third-party modules that must be jest.mock()'d or the file explodes on
 * import. Extend this map per repo — it is the difference between a generated
 * test that runs and one the developer deletes.
 */
const MOCK_REQUIRED: Record<string, string> = {
  'react-native-keychain': 'react-native-keychain',
  '@react-native-async-storage/async-storage': '@react-native-async-storage/async-storage',
  'react-native-device-info': 'react-native-device-info',
  'react-native-biometrics': 'react-native-biometrics',
  '@react-navigation/native': '@react-navigation/native',
  '@react-navigation/native-stack': '@react-navigation/native-stack',
  'react-native-permissions': 'react-native-permissions',
  'react-native-webview': 'react-native-webview',
  '@react-native-firebase/analytics': '@react-native-firebase/analytics',
  'react-native-encrypted-storage': 'react-native-encrypted-storage',
  'react-native-reanimated': 'react-native-reanimated',
};

const HOOK_RE = /^use[A-Z]/;

export function createProject(projectRoot: string): Project {
  const tsconfig = path.join(projectRoot, 'tsconfig.json');
  return new Project({
    tsConfigFilePath: fs.existsSync(tsconfig) ? tsconfig : undefined,
    skipAddingFilesFromTsConfig: !fs.existsSync(tsconfig),
    compilerOptions: { allowJs: true, jsx: 4 /* ReactJSX */ },
  });
}

/** Cognitive complexity, Sonar-style: +1 per control structure, +nesting depth. */
function cognitiveComplexity(node: Node): number {
  let score = 0;

  const walk = (n: Node, depth: number): void => {
    let increment = 0;
    let nestsChildren = false;

    switch (n.getKind()) {
      case SyntaxKind.IfStatement:
      case SyntaxKind.ForStatement:
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.WhileStatement:
      case SyntaxKind.DoStatement:
      case SyntaxKind.CatchClause:
      case SyntaxKind.SwitchStatement:
        increment = 1 + depth;
        nestsChildren = true;
        break;
      case SyntaxKind.ConditionalExpression:
        increment = 1 + depth;
        nestsChildren = true;
        break;
      case SyntaxKind.BinaryExpression: {
        const op = n.asKind(SyntaxKind.BinaryExpression)?.getOperatorToken().getKind();
        // Sequences of && / || each add 1 without nesting penalty.
        if (op === SyntaxKind.AmpersandAmpersandToken || op === SyntaxKind.BarBarToken) {
          increment = 1;
        }
        break;
      }
      default:
        break;
    }

    score += increment;
    for (const child of n.getChildren()) walk(child, depth + (nestsChildren ? 1 : 0));
  };

  for (const child of node.getChildren()) walk(child, 0);
  return score;
}

function collectExports(sf: SourceFile): string[] {
  const names = new Set<string>();
  for (const [name] of sf.getExportedDeclarations()) names.add(name);
  return [...names];
}

function findPropsType(sf: SourceFile): string | null {
  // Prefer an explicitly named Props type; fall back to the first interface.
  const candidates = [
    ...sf.getInterfaces().map((i) => ({ name: i.getName(), text: i.getText() })),
    ...sf.getTypeAliases().map((t) => ({ name: t.getName(), text: t.getText() })),
  ];
  const named = candidates.find((c) => /props$/i.test(c.name));
  return named?.text ?? candidates[0]?.text ?? null;
}

export function extractFacts(project: Project, absPath: string): FileFacts {
  const sf = project.addSourceFileAtPathIfExists(absPath) ?? project.addSourceFileAtPath(absPath);
  const text = sf.getFullText();

  const localImports: FileFacts['localImports'] = [];
  const externalImports: string[] = [];
  const requiredMocks = new Set<string>();

  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const resolved = imp.getModuleSpecifierSourceFile()?.getFilePath() ?? null;
      localImports.push({ specifier: spec, resolvedPath: resolved ? String(resolved) : null });
    } else {
      externalImports.push(spec);
      const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (MOCK_REQUIRED[spec]) requiredMocks.add(MOCK_REQUIRED[spec]);
      else if (MOCK_REQUIRED[root]) requiredMocks.add(MOCK_REQUIRED[root]);
    }
  }

  const hooksUsed = new Set<string>();
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const name = call.getExpression().getText();
    const short = name.split('.').pop() ?? name;
    if (HOOK_RE.test(short)) hooksUsed.add(short);
  }

  const complexityByExport: Record<string, number> = {};
  for (const [name, decls] of sf.getExportedDeclarations()) {
    let max = 0;
    for (const d of decls) max = Math.max(max, cognitiveComplexity(d));
    complexityByExport[name] = max;
  }

  const isComponent =
    absPath.endsWith('.tsx') &&
    (sf.getDescendantsOfKind(SyntaxKind.JsxElement).length > 0 ||
      sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement).length > 0 ||
      sf.getDescendantsOfKind(SyntaxKind.JsxFragment).length > 0);

  return {
    path: absPath,
    isComponent,
    exports: collectExports(sf),
    localImports,
    externalImports: [...new Set(externalImports)],
    propsTypeText: findPropsType(sf),
    hooksUsed: [...hooksUsed],
    complexityByExport,
    requiredMocks: [...requiredMocks],
    loc: text.split('\n').length,
  };
}
