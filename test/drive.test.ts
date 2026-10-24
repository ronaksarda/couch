import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ screen: {} }));
const { cornerPoint, duration, hermite, nearestCorner, MAX_T, MIN_T, SPEED_CAP } = await import('../electron/drive');

describe('drive math', () => {
  it('clamps duration and keeps peak speed near the cap', () => {
    expect(duration(0)).toBe(MIN_T);
    expect(duration(100_000)).toBe(MAX_T);
    const T = duration(1000);
    let peak = 0;
    for (let t = 0; t <= T; t += T / 200) peak = Math.max(peak, Math.abs(hermite(0, 0, 1000, T, t).v));
    expect(peak).toBeLessThanOrEqual(SPEED_CAP + 1);
  });

  it('starts at p0 with v0 and ends at p1 at rest', () => {
    const a = hermite(10, 300, 500, 1.2, 0);
    expect(a.p).toBeCloseTo(10);
    expect(a.v).toBeCloseTo(300);
    const b = hermite(10, 300, 500, 1.2, 1.2);
    expect(b.p).toBeCloseTo(500);
    expect(b.v).toBeCloseTo(0);
  });

  it('snaps to the right corner', () => {
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    expect(nearestCorner(area, { x: 1800, y: 900 })).toBe('br');
    expect(nearestCorner(area, { x: 100, y: 100 })).toBe('tl');
    expect(cornerPoint(area, 'br', 240, 210)).toEqual({ x: 1672, y: 822 });
  });
});
