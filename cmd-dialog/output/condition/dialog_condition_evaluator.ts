/**
 * DIALOG CONDITION EVALUATOR — Implementation (Phase 8 Contract #3).
 *
 * Pure parser + evaluator. No eval(), no Function(). Registry-driven.
 */
import type {
  BranchResolveOutcome,
  ConditionContext,
  ConditionExpression,
  DialogBranch,
  DialogConditionHook,
  DialogId,
  DialogNode,
  DialogNodeId,
  DialogRegistry,
  DialogTree,
} from './dialog_condition_hook.js';
import type { ConditionComplexityGuard } from './condition_complexity_guard.js';

type Token =
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'op'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'literal'; value: string };

interface AST {
  kind: 'literal' | 'identifier' | 'binary_op' | 'logical_and' | 'logical_or' | 'logical_not';
  value?: string;
  children: AST[];
  func?: string;
  arg?: string;
}

export class DialogConditionEvaluator implements DialogConditionHook {
  private complexityGuard?: ConditionComplexityGuard;

  resolveBranch(
    node: DialogNode,
    context: ConditionContext,
    ordinal: number,
  ): BranchResolveOutcome {
    let pickedBranch: DialogBranch | undefined;
    for (const branch of node.branches) {
      if (!branch.condition) {
        pickedBranch = branch;
        break;
      }
      if (this.evaluateCondition(branch.condition, context)) {
        pickedBranch = branch;
        break;
      }
    }
    if (!pickedBranch) {
      throw new Error(`No branch matched at node ${node.node_id} (need default branch)`);
    }

    return {
      dialog_id: '' as DialogId, // caller sets — node alone doesn't know parent
      current_node_id: node.node_id,
      picked_branch_id: pickedBranch.branch_id,
      next_node_id: pickedBranch.next_node_id,
      emit_event_kind: pickedBranch.emit_event_kind,
      terminal: node.terminal || !pickedBranch.next_node_id,
      ordinal,
    };
  }

  evaluateCondition(expression: ConditionExpression, context: ConditionContext): boolean {
    // Optional complexity gate
    if (this.complexityGuard) {
      const r = this.complexityGuard.validateCondition(expression);
      if (r.status !== 'ok') {
        throw new Error(`Condition rejected by complexity guard: ${r.status} — ${r.reason ?? ''}`);
      }
    }
    const tokens = tokenize(expression);
    const parser = new Parser(tokens);
    const ast = parser.parseExpr();
    if (!parser.atEnd()) throw new Error('Unexpected trailing tokens in condition');
    return evalAST(ast, context);
  }

  attachComplexityGuard(guard: ConditionComplexityGuard): void {
    this.complexityGuard = guard;
  }

  _resetForTest(): void {
    this.complexityGuard = undefined;
  }
}

export class InMemoryDialogRegistry implements DialogRegistry {
  private store = new Map<DialogId, DialogTree>();

  register(tree: DialogTree): void {
    if (this.store.has(tree.id)) {
      throw new Error(`Dialog ${tree.id} already registered`);
    }
    this.store.set(tree.id, tree);
  }

  get(dialog_id: DialogId): DialogTree | undefined {
    return this.store.get(dialog_id);
  }

  listIds(): readonly DialogId[] {
    return [...this.store.keys()].sort();
  }

  has(dialog_id: DialogId): boolean {
    return this.store.has(dialog_id);
  }

  /** Get node by tree + node_id. */
  getNode(dialog_id: DialogId, node_id: DialogNodeId): DialogNode | undefined {
    return this.store.get(dialog_id)?.nodes.find((n) => n.node_id === node_id);
  }
}

// ───────── Tokenize + Parse + Eval (shared with complexity guard, kept local for impl isolation) ─────────

function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }
    if (ch === '(') { tokens.push({ kind: 'lparen' }); i++; continue; }
    if (ch === ')') { tokens.push({ kind: 'rparen' }); i++; continue; }
    if (ch === '=' && s[i + 1] === '=') { tokens.push({ kind: 'op', value: '==' }); i += 2; continue; }
    if (ch === '>' && s[i + 1] === '=') { tokens.push({ kind: 'op', value: '>=' }); i += 2; continue; }
    if (ch === '<' && s[i + 1] === '=') { tokens.push({ kind: 'op', value: '<=' }); i += 2; continue; }
    if (ch === '>') { tokens.push({ kind: 'op', value: '>' }); i++; continue; }
    if (ch === '<') { tokens.push({ kind: 'op', value: '<' }); i++; continue; }
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
    throw new Error(`Unexpected char '${ch}'`);
  }
  return tokens;
}

class Parser {
  constructor(private readonly t: Token[]) {}
  private pos = 0;
  atEnd(): boolean { return this.pos >= this.t.length; }
  parseExpr(): AST { return this.parseOr(); }

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
    if (this.peek()?.kind === 'ident') {
      const fnTok = this.advance()!;
      if (fnTok.kind !== 'ident') throw new Error('expected ident');
      if (!this.match('lparen')) throw new Error('Expected ( after identifier');
      const argTok = this.advance();
      if (!argTok || argTok.kind !== 'ident') throw new Error('Expected arg');
      if (!this.match('rparen')) throw new Error('Missing close paren in identifier');
      const idAst: AST = { kind: 'identifier', children: [], func: fnTok.value, arg: argTok.value };
      const next = this.peek();
      if (next?.kind === 'op' && ['==', '>=', '<=', '>', '<'].includes(next.value)) {
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
    throw new Error('Unexpected token');
  }
  private peek(): Token | undefined { return this.t[this.pos]; }
  private advance(): Token | undefined { return this.t[this.pos++]; }
  private match(kind: Token['kind'], value?: string): boolean {
    const cur = this.peek();
    if (!cur || cur.kind !== kind) return false;
    if (value !== undefined && 'value' in cur && cur.value !== value) return false;
    this.pos++;
    return true;
  }
}

function evalAST(node: AST, ctx: ConditionContext): boolean {
  switch (node.kind) {
    case 'logical_and':
      return evalAST(node.children[0]!, ctx) && evalAST(node.children[1]!, ctx);
    case 'logical_or':
      return evalAST(node.children[0]!, ctx) || evalAST(node.children[1]!, ctx);
    case 'logical_not':
      return !evalAST(node.children[0]!, ctx);
    case 'identifier': {
      // Bare identifier (no comparator) — treat as boolean: value > 0
      const v = lookupIdentifier(node.func!, node.arg!, ctx);
      if (typeof v === 'number') return v > 0;
      return Boolean(v);
    }
    case 'binary_op': {
      const left = node.children[0]!;
      const right = node.children[1]!;
      const lv = lookupIdentifier(left.func!, left.arg!, ctx);
      const rRaw = right.value!;
      const rv: number | string = /^[0-9]+$/.test(rRaw) ? parseInt(rRaw, 10) : rRaw;
      switch (node.value) {
        case '==':
          return lv === rv;
        case '>=':
          return typeof lv === 'number' && typeof rv === 'number' && lv >= rv;
        case '<=':
          return typeof lv === 'number' && typeof rv === 'number' && lv <= rv;
        case '>':
          return typeof lv === 'number' && typeof rv === 'number' && lv > rv;
        case '<':
          return typeof lv === 'number' && typeof rv === 'number' && lv < rv;
        default:
          throw new Error(`Unknown comparator ${node.value}`);
      }
    }
    case 'literal':
      throw new Error('Bare literal in eval context');
  }
}

function lookupIdentifier(
  func: string,
  arg: string,
  ctx: ConditionContext,
): number | string {
  switch (func) {
    case 'flag':
      return ctx.flags[arg] ?? 0;
    case 'quest':
      return ctx.quest_states[arg] ?? '';
    case 'affinity':
      return ctx.companion_affinity_points[arg] ?? 0;
    case 'affinity_tier':
      return ctx.companion_affinity_tiers[arg] ?? 'stranger';
    default:
      throw new Error(`Unknown identifier function ${func}`);
  }
}
