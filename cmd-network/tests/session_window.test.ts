import { describe, it, expect } from 'vitest';
import { SessionWindow } from '../output/r69/session_window.js';

describe('R69.5 SessionWindow — admission', () => {
  it('admits up to windowSize seqs', () => {
    const w = new SessionWindow({ windowSize: 3 });
    expect(w.tryAdmit(1).admitted).toBe(true);
    expect(w.tryAdmit(2).admitted).toBe(true);
    expect(w.tryAdmit(3).admitted).toBe(true);
    expect(w.pendingCount()).toBe(3);
    expect(w.isFull()).toBe(true);
  });

  it('returns NACK retry hint when window is full', () => {
    const w = new SessionWindow({ windowSize: 2, retryHintPerPendingMs: 100 });
    w.tryAdmit(1);
    w.tryAdmit(2);
    const r = w.tryAdmit(3);
    expect(r.admitted).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(r.pendingBefore).toBe(2);
  });

  it('rejects duplicate in-flight seq with retry hint', () => {
    const w = new SessionWindow({ windowSize: 10 });
    w.tryAdmit(5);
    const r = w.tryAdmit(5);
    expect(r.admitted).toBe(false);
    expect(r.pendingBefore).toBe(1);
  });

  it('frees a slot when ack() called with pending seq', () => {
    const w = new SessionWindow({ windowSize: 2 });
    w.tryAdmit(1);
    w.tryAdmit(2);
    expect(w.isFull()).toBe(true);
    expect(w.ack(1)).toBe(true);
    expect(w.pendingCount()).toBe(1);
    expect(w.isFull()).toBe(false);
    expect(w.tryAdmit(3).admitted).toBe(true);
  });

  it('ack() returns false for unknown seq', () => {
    const w = new SessionWindow();
    expect(w.ack(42)).toBe(false);
    w.tryAdmit(42);
    expect(w.ack(43)).toBe(false);
  });

  it('ack() rejects invalid seq input', () => {
    const w = new SessionWindow();
    expect(w.ack(-1)).toBe(false);
    expect(w.ack(NaN)).toBe(false);
    expect(w.ack(1.5)).toBe(false);
  });

  it('reset() clears pending', () => {
    const w = new SessionWindow({ windowSize: 5 });
    w.tryAdmit(1);
    w.tryAdmit(2);
    w.reset();
    expect(w.pendingCount()).toBe(0);
    expect(w.tryAdmit(1).admitted).toBe(true); // ok to re-admit after reconnect
  });

  it('pendingSnapshot returns sorted asc', () => {
    const w = new SessionWindow();
    w.tryAdmit(7);
    w.tryAdmit(2);
    w.tryAdmit(99);
    expect(w.pendingSnapshot()).toEqual([2, 7, 99]);
  });

  it('default windowSize = 50 per Foundation R69.5', () => {
    const w = new SessionWindow();
    expect(w.getWindowSize()).toBe(50);
  });

  it('rejects fractional / NaN / 0 windowSize', () => {
    expect(() => new SessionWindow({ windowSize: 0 })).toThrow(/positive integer/);
    expect(() => new SessionWindow({ windowSize: 1.5 })).toThrow(/positive integer/);
    expect(() => new SessionWindow({ windowSize: NaN })).toThrow(/positive integer/);
    expect(() => new SessionWindow({ windowSize: Infinity })).toThrow(/positive integer/);
  });

  it('rejects negative retryHintPerPendingMs', () => {
    expect(() => new SessionWindow({ retryHintPerPendingMs: -1 })).toThrow(/non-negative/);
  });

  it('tryAdmit rejects invalid seq inputs (NaN/Infinity/negative/fractional)', () => {
    const w = new SessionWindow();
    expect(() => w.tryAdmit(-1)).toThrow(/integer in/);
    expect(() => w.tryAdmit(NaN)).toThrow(/integer in/);
    expect(() => w.tryAdmit(Infinity)).toThrow(/integer in/);
    expect(() => w.tryAdmit(1.5)).toThrow(/integer in/);
  });
});
