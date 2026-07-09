// Deep-link resolver (Task E1). Valid routes → targets; everything unroutable → null.

import { describe, it, expect } from 'vitest';

import { resolveDeepLink } from './deeplink';

describe('resolveDeepLink — valid routes', () => {
  it('resolves a bare workspace link (the notification click-through format)', () => {
    expect(resolveDeepLink('harness://workspace/ws-123')).toEqual({
      workspaceId: 'ws-123',
    });
  });

  it('resolves a workspace + diff pane', () => {
    expect(resolveDeepLink('harness://workspace/ws-123/diff')).toEqual({
      workspaceId: 'ws-123',
      pane: 'diff',
    });
  });

  it('resolves a workspace + pr pane', () => {
    expect(resolveDeepLink('harness://workspace/ws-123/pr')).toEqual({
      workspaceId: 'ws-123',
      pane: 'pr',
    });
  });

  it('ignores a query string / fragment', () => {
    expect(resolveDeepLink('harness://workspace/ws-1?ref=notif#x')).toEqual({
      workspaceId: 'ws-1',
    });
  });

  it('percent-decodes the workspace id', () => {
    expect(resolveDeepLink('harness://workspace/ws%20a')).toEqual({
      workspaceId: 'ws a',
    });
  });
});

describe('resolveDeepLink — unroutable → null', () => {
  it('rejects a wrong scheme', () => {
    expect(resolveDeepLink('https://workspace/ws-1')).toBeNull();
  });

  it('rejects an unknown host', () => {
    expect(resolveDeepLink('harness://project/ws-1')).toBeNull();
  });

  it('rejects a missing workspace id', () => {
    expect(resolveDeepLink('harness://workspace/')).toBeNull();
    expect(resolveDeepLink('harness://workspace')).toBeNull();
  });

  it('rejects an unknown pane', () => {
    expect(resolveDeepLink('harness://workspace/ws-1/settings')).toBeNull();
  });

  it('rejects extra path segments', () => {
    expect(resolveDeepLink('harness://workspace/ws-1/diff/extra')).toBeNull();
  });
});
