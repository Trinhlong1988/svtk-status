import { describe, it, expect } from 'vitest';
import { OrderedReceiver } from '../output/r69/ordered_receiver.js';

describe('R69.2 OrderedReceiver — Foundation buffering semantics', () => {
  it('delivers in-order seqs immediately', () => {
    const r = new OrderedReceiver<string>();
    expect(r.receive(0, 'a').delivered).toEqual(['a']);
    expect(r.receive(1, 'b').delivered).toEqual(['b']);
    expect(r.receive(2, 'c').delivered).toEqual(['c']);
    expect(r.getExpectedNext()).toBe(3);
  });

  it('buffers out-of-order seq until predecessor arrives, then drains', () => {
    const r = new OrderedReceiver<string>();
    expect(r.receive(0, 'a').delivered).toEqual(['a']);
    const buf = r.receive(2, 'c');
    expect(buf.delivered).toEqual([]);
    expect(buf.buffered).toBe(true);
    expect(r.getBufferSize()).toBe(1);
    const drain = r.receive(1, 'b');
    expect(drain.delivered).toEqual(['b', 'c']);
    expect(r.getBufferSize()).toBe(0);
    expect(r.getExpectedNext()).toBe(3);
  });

  it('drops duplicate seq < expectedNext', () => {
    const r = new OrderedReceiver<string>();
    r.receive(0, 'a');
    r.receive(1, 'b');
    const dup = r.receive(0, 'a-replay');
    expect(dup.delivered).toEqual([]);
    expect(dup.duplicate).toBe(true);
  });

  it('drops duplicate buffered seq', () => {
    const r = new OrderedReceiver<string>();
    r.receive(0, 'a');
    r.receive(3, 'd'); // buffered
    const dup = r.receive(3, 'd-dup');
    expect(dup.duplicate).toBe(true);
  });

  it('overflow when buffer full beyond bufferLimit', () => {
    const r = new OrderedReceiver<string>({ bufferLimit: 2 });
    r.receive(0, 'a'); // delivered
    r.receive(2, 'c'); // buffer (size 1)
    r.receive(3, 'd'); // buffer (size 2, full)
    const over = r.receive(4, 'e'); // overflow
    expect(over.overflow).toBe(true);
    expect(over.delivered).toEqual([]);
  });

  it('drains long buffered run after gap fills', () => {
    const r = new OrderedReceiver<number>();
    r.receive(0, 0);
    for (let i = 5; i < 10; i++) r.receive(i, i); // buffer 5..9
    // gap fill 1..4
    for (let i = 1; i < 5; i++) r.receive(i, i);
    // now seq=4 should drain 4..9 (5 was buffered, so should chain)
    expect(r.getExpectedNext()).toBe(10);
    expect(r.getBufferSize()).toBe(0);
  });

  it('drops invalid seq (NaN / negative / > MAX_SAFE_INTEGER)', () => {
    const r = new OrderedReceiver<string>();
    expect(r.receive(NaN, 'x').delivered).toEqual([]);
    expect(r.receive(-1, 'x').delivered).toEqual([]);
    expect(r.receive(Number.MAX_SAFE_INTEGER + 1, 'x').delivered).toEqual([]);
    expect(r.getExpectedNext()).toBe(0); // state unchanged
  });

  it('reset() clears state (R69.6)', () => {
    const r = new OrderedReceiver<string>();
    r.receive(0, 'a');
    r.receive(2, 'c');
    r.reset();
    expect(r.getExpectedNext()).toBe(0);
    expect(r.getBufferSize()).toBe(0);
    expect(r.receive(0, 'a-fresh').delivered).toEqual(['a-fresh']);
  });

  it('constructor rejects invalid initialSeq / bufferLimit', () => {
    expect(() => new OrderedReceiver({ initialSeq: -1 })).toThrow(/non-negative integer/);
    expect(() => new OrderedReceiver({ initialSeq: 1.5 })).toThrow(/non-negative integer/);
    expect(() => new OrderedReceiver({ bufferLimit: 0 })).toThrow(/positive integer/);
    expect(() => new OrderedReceiver({ bufferLimit: NaN })).toThrow(/positive integer/);
  });

  it('bufferedSeqs() returns sorted ascending', () => {
    const r = new OrderedReceiver<string>();
    r.receive(0, 'a');
    r.receive(5, 'f');
    r.receive(2, 'c');
    r.receive(8, 'i');
    expect(r.bufferedSeqs()).toEqual([2, 5, 8]);
  });
});
