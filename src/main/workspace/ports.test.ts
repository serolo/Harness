// Unit tests for the workspace TCP-port allocator.
// Pure: depends only on node:net, no Electron, no DB. Runs in the default node environment.

import { describe, it, expect } from 'vitest';
import { allocate } from './ports';

describe('allocate — ports', () => {
  it('returns a number within the default range [3000, 3999]', async () => {
    const port = await allocate();
    expect(typeof port).toBe('number');
    expect(port).toBeGreaterThanOrEqual(3000);
    expect(port).toBeLessThanOrEqual(3999);
  });

  it('returns a port not in the taken list', async () => {
    // Take a wide swath of low ports so allocator must skip them
    const taken = Array.from({ length: 50 }, (_, i) => 3000 + i);
    const port = await allocate({ taken });
    expect(taken).not.toContain(port);
    expect(port).toBeGreaterThanOrEqual(3000);
    expect(port).toBeLessThanOrEqual(3999);
  });

  it('respects a custom range', async () => {
    const port = await allocate({ range: [4000, 4099] });
    expect(port).toBeGreaterThanOrEqual(4000);
    expect(port).toBeLessThanOrEqual(4099);
  });

  it('two sequential allocations with the first result in taken are distinct', async () => {
    const first = await allocate();
    const second = await allocate({ taken: [first] });
    expect(second).not.toBe(first);
    expect(second).toBeGreaterThanOrEqual(3000);
    expect(second).toBeLessThanOrEqual(3999);
  });

  it('throws when every port in the range is taken', async () => {
    // A range of exactly one port, and that port is in taken
    await expect(
      allocate({ range: [3500, 3500], taken: [3500] }),
    ).rejects.toThrow(/no free port available/i);
  });
});
