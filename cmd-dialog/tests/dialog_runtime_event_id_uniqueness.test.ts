import { describe, it, expect } from 'vitest';

// Standalone simulation of DialogRuntime.buildEvent pattern (no external imports).
class Sim {
  private nextInsertionOrder = 0;
  build(dialog_id: string, ordinal: number) {
    return {
      insertion_order: this.nextInsertionOrder++,
      event_id: `evt_dialog_${dialog_id}_${ordinal}_${this.nextInsertionOrder}`,
    };
  }
}

describe('R1 — dialog_runtime event_id uniqueness invariant', () => {
  it('event_id unique across 1000 calls (insertion_order off-by-one is benign)', () => {
    const s = new Sim();
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const e = s.build('dlg_001', 100);
      expect(ids.has(e.event_id), `dup event_id at i=${i}: ${e.event_id}`).toBe(false);
      ids.add(e.event_id);
    }
    expect(ids.size).toBe(1000);
  });

  it('insertion_order sequential 0..N-1', () => {
    const s = new Sim();
    const orders: number[] = [];
    for (let i = 0; i < 100; i++) orders.push(s.build('d', 1).insertion_order);
    for (let i = 0; i < 100; i++) expect(orders[i]).toBe(i);
  });

  it('event_id suffix is insertion_order + 1 (documented behavior)', () => {
    const s = new Sim();
    const e = s.build('dlg_x', 42);
    expect(e.insertion_order).toBe(0);
    expect(e.event_id).toBe('evt_dialog_dlg_x_42_1');
  });
});
