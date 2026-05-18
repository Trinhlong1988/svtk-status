/**
 * CONDITION COMPLEXITY GUARD — Implementation (Phase 8 FIX #6).
 *
 * Tokenize → AST → measure depth/tokens/references. No eval(), no Function().
 *
 * Grammar (recursive descent):
 *   expr      ::= or_expr
 *   or_expr   ::= and_expr ('OR' and_expr)*
 *   and_expr  ::= not_expr ('AND' not_expr)*
 *   not_expr  ::= 'NOT' not_expr | primary
 *   primary   ::= '(' expr ')' | comparison | identifier
 *   comparison::= identifier comp_op literal
 *   identifier::= func '(' arg ')'
 *   func      ::= 'flag' | 'quest' | 'affinity' | 'affinity_tier'
 *   comp_op   ::= '==' | '>=' | '<=' | '>' | '<'
 *   literal   ::= integer | bare_word
 */
import type {
  ConditionComplexityGuard,
  ConditionGuardConfig,
  ConditionReferenceGraph,
  ConditionValidationResult,
} from './condition_complexity_guard.js';
import { ConditionGuardConfigSchema } from './condition_complexity_guard.js';
import type { ConditionExpression } from './dialog_condition_hook.js';

const DEFAULT_CONFIG = ConditionGuardConfigSchema.parse({});

type Token =
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'op'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'literal'; value: string };

interface AST {
  kind:
    | 'literal'
    | 'identifier'
    | 'binary_op'
    | 'logical_and'
    | 'logical_or'
    | 'logical_not';
  value?: string;
  children: AST[];
  /** Identifier function name (flag/quest/affinity/affinity_tier). */
  func?: string;
  /** Identifier argument. */
  arg?: string;
}

export class ConditionComplexityGuardImpl implements ConditionComplexityGuard {
  private readonly config: ConditionGuardConfig;

  constructor(config: Partial<ConditionGuardConfig> = {}) {
    this.config = ConditionGuardConfigSchema.parse({ ...DEFAULT_CONFIG, ...config });
  }

  validateCondition(expression: ConditionExpression): ConditionValidationResult {
    let tokens: Token[];
    try {
      tokens = tokenize(expression);
    } catch (e) {
      return this.fail(expression, 'malformed', `Tokenize: ${(e as Error).message}`);
    }

    if (tokens.length > this.config.max_token_count) {
      return {
        status: 'token_count_exceeded',
        expression,
        measured_depth: 0,
        measured_token_count: tokens.length,
        measured_reference_count: 0,
        reason: `Token count ${tokens.length} > ${this.config.max_token_count}`,
      };
    }

    // Operator whitelist — check op tokens + function-name identifiers (ident before lparen)
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.kind === 'op') {
        const op = t.value;
        if (!this.config.allowed_operators.includes(op)) {
          return this.fail(expression, 'operator_not_allowed', `Operator '${op}' not in whitelist`);
        }
      }
      // Identifier preceding lparen = function call (vd `flag(`, `eval(`)
      if (t.kind === 'ident' && tokens[i + 1]?.kind === 'lparen') {
        if (!this.config.allowed_operators.includes(t.value)) {
          return this.fail(
            expression,
            'operator_not_allowed',
            `Function '${t.value}' not in whitelist`,
          );
        }
      }
    }

    let ast: AST;
    try {
      const parser = new Parser(tokens);
      ast = parser.parseExpr();
      if (!parser.atEnd()) throw new Error('Unexpected trailing tokens');
    } catch (e) {
      return this.fail(expression, 'malformed', `Parse: ${(e as Error).message}`);
    }

    const depth = astDepth(ast);
    const refs = collectReferences(ast);

    if (depth > this.config.max_condition_depth) {
      return {
        status: 'depth_exceeded',
        expression,
        measured_depth: depth,
        measured_token_count: tokens.length,
        measured_reference_count: refs.length,
        reason: `Depth ${depth} > ${this.config.max_condition_depth}`,
      };
    }

    if (refs.length > this.config.max_referenced_flags) {
      return {
        status: 'reference_count_exceeded',
        expression,
        measured_depth: depth,
        measured_token_count: tokens.length,
        measured_reference_count: refs.length,
        reason: `Reference count ${refs.length} > ${this.config.max_referenced_flags}`,
      };
    }

    return {
      status: 'ok',
      expression,
      measured_depth: depth,
      measured_token_count: tokens.length,
      measured_reference_count: refs.length,
    };
  }

  buildReferenceGraph(
    expressions: ReadonlyMap<string, ConditionExpression>,
  ): ConditionReferenceGraph {
    const edges: { source: string; target: string }[] = [];
    const sortedKeys = [...expressions.keys()].sort();
    for (const src of sortedKeys) {
      const expr = expressions.get(src)!;
      let tokens: Token[];
      try {
        tokens = tokenize(expr);
      } catch {
        continue;
      }
      let ast: AST;
      try {
        const parser = new Parser(tokens);
        ast = parser.parseExpr();
      } catch {
        continue;
      }
      const refs = collectReferences(ast).sort();
      for (const r of refs) edges.push({ source: src, target: r });
    }
    const cycles = detectCycles(edges);
    return { edges, cycles };
  }

  hasCycleReference(
    expression: ConditionExpression,
    graph: ConditionReferenceGraph,
  ): boolean {
    let tokens: Token[];
    try {
      tokens = tokenize(expression);
    } catch {
      return false;
    }
    let ast: AST;
    try {
      ast = new Parser(tokens).parseExpr();
    } catch {
      return false;
    }
    const refs = collectReferences(ast);
    return graph.cycles.some((c) => refs.some((r) => c.includes(r)));
  }

  _resetForTest(): void {
    // Stateless
  }

  private fail(
    expression: string,
    status: ConditionValidationResult['status'],
    reason: string,
  ): ConditionValidationResult {
    return {
      status,
      expression,
      measured_depth: 0,
      measured_token_count: 0,
      measured_reference_count: 0,
      reason,
    };
  }
}

function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    if (ch === '=' && s[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '==' });
      i += 2;
      continue;
    }
    if (ch === '>' && s[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '>=' });
      i += 2;
      continue;
    }
    if (ch === '<' && s[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '<=' });
      i += 2;
      continue;
    }
    if (ch === '>') {
      tokens.push({ kind: 'op', value: '>' });
      i++;
      continue;
    }
    if (ch === '<') {
      tokens.push({ kind: 'op', value: '<' });
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) j++;
      const word = s.slice(i, j);
      if (word === 'AND' || word === 'OR' || word === 'NOT') {
        tokens.push({ kind: 'op', value: word });
      } else {
        tokens.push({ kind: 'ident', value: word });
      }
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9]/.test(s[j]!)) j++;
      tokens.push({ kind: 'literal', value: s.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected char '${ch}' at pos ${i}`);
  }
  return tokens;
}

class Parser {
  constructor(private readonly t: Token[]) {}
  private pos = 0;

  atEnd(): boolean {
    return this.pos >= this.t.length;
  }

  parseExpr(): AST {
    return this.parseOr();
  }

  private parseOr(): AST {
    let left = this.parseAnd();
    while (this.match('op', 'OR')) {
      const right = this.parseAnd();
      left = { kind: 'logical_or', children: [left, right] };
    }
    return left;
  }

  private parseAnd(): AST {
    let left = this.parseNot();
    while (this.match('op', 'AND')) {
      const right = this.parseNot();
      left = { kind: 'logical_and', children: [left, right] };
    }
    return left;
  }

  private parseNot(): AST {
    if (this.match('op', 'NOT')) {
      const inner = this.parseNot();
      return { kind: 'logical_not', children: [inner] };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): AST {
    if (this.match('lparen')) {
      const inner = this.parseExpr();
      if (!this.match('rparen')) throw new Error('Missing close paren');
      return inner;
    }
    // identifier or comparison
    if (this.peek()?.kind === 'ident') {
      const fnTok = this.advance()!;
      if (fnTok.kind !== 'ident') throw new Error('expected ident');
      if (!this.match('lparen')) throw new Error('Expected ( after identifier');
      const argTok = this.advance();
      if (!argTok || argTok.kind !== 'ident') throw new Error('Expected arg in identifier');
      if (!this.match('rparen')) throw new Error('Missing close paren in identifier');
      const idAst: AST = { kind: 'identifier', children: [], func: fnTok.value, arg: argTok.value };
      // optional comparison
      const next = this.peek();
      if (
        next?.kind === 'op' &&
        ['==', '>=', '<=', '>', '<'].includes(next.value)
      ) {
        const opTok = this.advance()!;
        const litTok = this.advance();
        if (!litTok || (litTok.kind !== 'literal' && litTok.kind !== 'ident')) {
          throw new Error('Expected literal/ident after comparator');
        }
        const litAst: AST = { kind: 'literal', children: [], value: (litTok as { value: string }).value };
        return {
          kind: 'binary_op',
          value: (opTok as { value: string }).value,
          children: [idAst, litAst],
        };
      }
      return idAst;
    }
    throw new Error(`Unexpected token at pos ${this.pos}`);
  }

  private peek(): Token | undefined {
    return this.t[this.pos];
  }

  private advance(): Token | undefined {
    return this.t[this.pos++];
  }

  private match(kind: Token['kind'], value?: string): boolean {
    const cur = this.peek();
    if (!cur || cur.kind !== kind) return false;
    if (value !== undefined && 'value' in cur && cur.value !== value) return false;
    this.pos++;
    return true;
  }
}

function astDepth(node: AST): number {
  if (node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map(astDepth));
}

function collectReferences(node: AST): string[] {
  const refs: string[] = [];
  walk(node, (n) => {
    if (n.kind === 'identifier' && n.arg) refs.push(n.arg);
  });
  return refs;
}

function walk(node: AST, fn: (n: AST) => void): void {
  fn(node);
  for (const c of node.children) walk(c, fn);
}

function detectCycles(edges: readonly { source: string; target: string }[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source) ?? [];
    list.push(e.target);
    adj.set(e.source, list);
  }
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  const sortedNodes = [...new Set(edges.flatMap((e) => [e.source, e.target]))].sort();

  function dfs(node: string): void {
    if (stack.has(node)) {
      const idx = path.indexOf(node);
      if (idx !== -1) {
        const cycle = path.slice(idx).concat(node);
        // Canonical: smallest first
        const min = Math.min(...cycle.map((_, i) => i));
        cycles.push(cycle.slice(min));
      }
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.add(node);
    path.push(node);
    for (const next of (adj.get(node) ?? []).slice().sort()) dfs(next);
    path.pop();
    stack.delete(node);
  }
  for (const n of sortedNodes) dfs(n);
  return cycles;
}
