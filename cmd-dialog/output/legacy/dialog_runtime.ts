/**
 * DIALOG RUNTIME — Phase 9 §VIII.
 *
 * Full dialog walker with progression/faction/companion/world-state gate checks.
 * NO eval, NO dynamic execution. Data-driven.
 */
import type {
  BranchResolveOutcome,
  ConditionContext,
  DialogId,
  DialogNodeId,
} from './dialog_condition_hook.js';
import type { DialogConditionEvaluator, InMemoryDialogRegistry } from './dialog_condition_evaluator.js';
import type { ProgressionEvent, ProgressionEventKind, ProgressionSourceType, QuestCharId } from './quest_types.js';

export interface DialogStepResult {
  dialog_id: DialogId;
  node_id: DialogNodeId;
  speaker_id: string;
  text_vi: string;
  outcome: BranchResolveOutcome;
  /** Optional event to emit downstream (caller forwards to ProgressionEventBridge). */
  emitted_event?: ProgressionEvent;
}

export interface DialogSession {
  dialog_id: DialogId;
  current_node_id: DialogNodeId;
  char_id: QuestCharId;
  history: DialogNodeId[];
  started_ordinal: number;
  terminal: boolean;
}

export class DialogRuntime {
  private sessions = new Map<string, DialogSession>();
  private nextInsertionOrder = 0;

  constructor(
    private readonly registry: InMemoryDialogRegistry,
    private readonly evaluator: DialogConditionEvaluator,
  ) {}

  startDialog(
    dialog_id: DialogId,
    char_id: QuestCharId,
    ordinal: number,
  ): DialogStepResult {
    const tree = this.registry.get(dialog_id);
    if (!tree) throw new Error(`Dialog ${dialog_id} not in registry`);
    const session: DialogSession = {
      dialog_id,
      current_node_id: tree.entry_node_id,
      char_id,
      history: [],
      started_ordinal: ordinal,
      terminal: false,
    };
    this.sessions.set(this.sessionKey(dialog_id, char_id), session);
    return this.resolveCurrentNode(session, this.emptyCtx(char_id, ordinal), ordinal);
  }

  advance(
    dialog_id: DialogId,
    char_id: QuestCharId,
    ctx: ConditionContext,
    ordinal: number,
  ): DialogStepResult {
    const session = this.sessions.get(this.sessionKey(dialog_id, char_id));
    if (!session) throw new Error(`No active session ${dialog_id} for ${char_id}`);
    if (session.terminal) throw new Error(`Dialog ${dialog_id} already terminal`);

    return this.resolveCurrentNode(session, ctx, ordinal);
  }

  endDialog(dialog_id: DialogId, char_id: QuestCharId): void {
    this.sessions.delete(this.sessionKey(dialog_id, char_id));
  }

  getSession(dialog_id: DialogId, char_id: QuestCharId): DialogSession | undefined {
    return this.sessions.get(this.sessionKey(dialog_id, char_id));
  }

  _resetForTest(): void {
    this.sessions.clear();
    this.nextInsertionOrder = 0;
  }

  private resolveCurrentNode(
    session: DialogSession,
    ctx: ConditionContext,
    ordinal: number,
  ): DialogStepResult {
    const node = this.registry.getNode(session.dialog_id, session.current_node_id);
    if (!node) throw new Error(`Node ${session.current_node_id} not in tree ${session.dialog_id}`);

    const outcome = this.evaluator.resolveBranch(node, ctx, ordinal);
    session.history.push(session.current_node_id);
    if (outcome.next_node_id) {
      session.current_node_id = outcome.next_node_id;
    } else {
      session.terminal = true;
    }
    if (outcome.terminal) session.terminal = true;

    let emitted: ProgressionEvent | undefined;
    if (outcome.emit_event_kind) {
      emitted = this.buildEvent(outcome.emit_event_kind, session, ordinal);
    }

    return {
      dialog_id: session.dialog_id,
      node_id: node.node_id,
      speaker_id: node.speaker_id,
      text_vi: node.text_vi,
      outcome: { ...outcome, dialog_id: session.dialog_id },
      emitted_event: emitted,
    };
  }

  private buildEvent(
    kind: ProgressionEventKind,
    session: DialogSession,
    ordinal: number,
  ): ProgressionEvent {
    const sourceType: ProgressionSourceType = 'dialog';
    return {
      kind,
      char_id: session.char_id,
      target_id: session.dialog_id,
      quantity: 1,
      ordinal,
      event_tick: ordinal,
      event_sequence: 0,
      event_priority: 20,
      source_type: sourceType,
      source_id: session.dialog_id,
      insertion_order: this.nextInsertionOrder++,
      recursion_depth: 0,
      event_id: `evt_dialog_${session.dialog_id}_${ordinal}_${this.nextInsertionOrder}`,
    };
  }

  private emptyCtx(char_id: QuestCharId, ordinal: number): ConditionContext {
    return {
      char_id,
      flags: {},
      quest_states: {},
      companion_affinity_points: {},
      companion_affinity_tiers: {},
      ordinal,
    };
  }

  private sessionKey(dialog_id: DialogId, char_id: QuestCharId): string {
    return `${char_id}|${dialog_id}`;
  }
}
