import { describe, it, expect } from 'vitest';

import { childProcessEnv } from './childEnv';

describe('childProcessEnv', () => {
  it('strips Node/Electron IPC variables while preserving normal inherited env', () => {
    const previous = {
      NODE_CHANNEL_FD: process.env.NODE_CHANNEL_FD,
      NODE_UNIQUE_ID: process.env.NODE_UNIQUE_ID,
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
      PATH: process.env.PATH,
    };
    try {
      process.env.NODE_CHANNEL_FD = '9';
      process.env.NODE_UNIQUE_ID = 'cluster-worker';
      process.env.ELECTRON_RUN_AS_NODE = '1';
      process.env.PATH = '/usr/bin';

      const env = childProcessEnv({ CUSTOM_TOKEN: 'ok' });

      expect(env.NODE_CHANNEL_FD).toBeUndefined();
      expect(env.NODE_UNIQUE_ID).toBeUndefined();
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(env.PATH).toBe('/usr/bin');
      expect(env.CUSTOM_TOKEN).toBe('ok');
    } finally {
      restoreEnv('NODE_CHANNEL_FD', previous.NODE_CHANNEL_FD);
      restoreEnv('NODE_UNIQUE_ID', previous.NODE_UNIQUE_ID);
      restoreEnv('ELECTRON_RUN_AS_NODE', previous.ELECTRON_RUN_AS_NODE);
      restoreEnv('PATH', previous.PATH);
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
