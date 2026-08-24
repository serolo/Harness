import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { AppError } from '@shared/errors';
import type { AgentRunPolicy } from '@shared/agents';
import type { HarnessId } from '@shared/harness';
import { metaRunControlDir } from '../paths';
import { sanitizeErrorMessage } from '../security/sanitize-error';

export type BrokerMethod =
  'dispatch' | 'continue_dispatch' | 'await_dispatches' | 'cancel_dispatch';
export interface BrokerRequest {
  id: string;
  token: string;
  method: BrokerMethod;
  params: unknown;
}
export interface BrokerResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BrokerSessionPolicy {
  runId: string;
  projectId: string;
  roles: Map<
    string,
    {
      providers: HarnessId[];
      purposes: string[];
      independentProvider?: boolean;
    }
  >;
  policy: AgentRunPolicy;
}

export interface ControlBrokerHandler {
  dispatch(session: BrokerSessionPolicy, params: unknown): Promise<unknown>;
  continueDispatch(
    session: BrokerSessionPolicy,
    params: unknown,
  ): Promise<unknown>;
  awaitDispatches(
    session: BrokerSessionPolicy,
    params: unknown,
  ): Promise<unknown>;
  cancelDispatch(
    session: BrokerSessionPolicy,
    params: unknown,
  ): Promise<unknown>;
}

interface Session {
  policy: BrokerSessionPolicy;
  token: string;
  expiresAt: number;
  requests: Set<string>;
  messageCount: number;
  server: Server;
  sockets: Set<Socket>;
  dir: string;
  socketDir?: string;
  socketPath: string;
  authFile: string;
}

const MAX_FRAME_BYTES = 512 * 1024;
const MAX_MESSAGES = 1_000;
const SOCKET_DIRECTORY_ATTEMPTS = 5;
const RUN_ID = /^[A-Za-z0-9-]{1,100}$/;
const SHORT_SOCKET_PATH = /^\/tmp\/hcb-[a-f0-9]{16}\/c\.sock$/;
const SHORT_SOCKET_DIRECTORY = /^hcb-[a-f0-9]{16}$/;
const WINDOWS_PIPE_PATH = /^\\\\\.\\pipe\\harness-meta-[a-f0-9]{32}$/;

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString('utf8');
}

/**
 * macOS limits Unix-domain socket paths to roughly 104 bytes. The user-data path can
 * legitimately exceed that, so keep only the socket in a short, unguessable, private
 * directory. The capability secret remains in the run's mode-0700 control directory.
 */
async function createSocketDirectory(): Promise<string> {
  for (let attempt = 0; attempt < SOCKET_DIRECTORY_ATTEMPTS; attempt += 1) {
    const candidate = join('/tmp', `hcb-${randomBytes(8).toString('hex')}`);
    try {
      await mkdir(candidate, { mode: 0o700 });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new AppError(
    'io',
    'failed to allocate private control socket directory',
  );
}

export function windowsControlPipeName(randomHex: string): string {
  if (!/^[a-f0-9]{32}$/.test(randomHex)) {
    throw new AppError('invalid_input', 'invalid control pipe identifier');
  }
  return `\\\\.\\pipe\\harness-meta-${randomHex}`;
}

async function createControlEndpoint(): Promise<{
  socketPath: string;
  socketDir?: string;
}> {
  if (process.platform === 'win32') {
    return {
      socketPath: windowsControlPipeName(randomBytes(16).toString('hex')),
    };
  }
  const socketDir = await createSocketDirectory();
  return { socketDir, socketPath: join(socketDir, 'c.sock') };
}

export class ControlBroker {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly handler: ControlBrokerHandler) {}

  async start(
    policy: BrokerSessionPolicy,
  ): Promise<{ authFile: string; socketPath: string }> {
    if (this.sessions.has(policy.runId))
      throw new AppError('conflict', 'control session already exists');
    const dir = metaRunControlDir(policy.runId);
    const authFile = join(dir, 'control.json');
    const token = randomBytes(32).toString('base64url');
    const { socketDir, socketPath } = await createControlEndpoint();
    const server = createServer();
    const session: Session = {
      policy,
      token,
      expiresAt: Date.now() + policy.policy.runTimeoutMs,
      requests: new Set(),
      messageCount: 0,
      server,
      sockets: new Set(),
      dir,
      ...(socketDir === undefined ? {} : { socketDir }),
      socketPath,
      authFile,
    };
    server.on('connection', (socket) => this.accept(session, socket));
    server.on('error', () => {
      /* request paths receive a bounded transport error */
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(socketPath, () => {
          server.off('error', onError);
          resolve();
        });
      });
      if (socketDir !== undefined) {
        await chmod(socketPath, 0o600);
        await writeFile(join(socketDir, 'run'), `${policy.runId}\n`, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
      }
      await writeFile(authFile, `${JSON.stringify({ socketPath, token })}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      for (const socket of session.sockets) socket.destroy();
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      if (socketDir !== undefined) {
        await rm(socketDir, { recursive: true, force: true });
      }
      await rm(authFile, { force: true });
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    this.sessions.set(policy.runId, session);
    return { authFile, socketPath };
  }

  async revoke(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session) {
      await this.cleanupPersisted(runId);
      return;
    }
    this.sessions.delete(runId);
    session.token = '';
    for (const socket of session.sockets) socket.destroy();
    await new Promise<void>((resolve) =>
      session.server.close(() => resolve()),
    ).catch(() => undefined);
    await rm(session.authFile, { force: true });
    if (session.socketDir !== undefined) {
      await rm(session.socketPath, { force: true });
      await rm(session.socketDir, { recursive: true, force: true });
    }
    await rm(session.dir, { recursive: true, force: true });
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.sessions.keys()].map((runId) => this.revoke(runId)),
    );
  }

  private accept(session: Session, socket: Socket): void {
    session.sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let handled = false;
    socket.on('close', () => session.sockets.delete(socket));
    // Peers can disconnect while an async handler is running. A late response must not
    // turn the resulting EPIPE into an uncaught main-process error.
    socket.on('error', () => socket.destroy());
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      if (buffer.length + chunk.length > MAX_FRAME_BYTES) {
        handled = true;
        socket.setTimeout(0);
        this.finishResponse(session, socket, {
          id: '',
          ok: false,
          error: 'request too large',
        });
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      handled = true;
      socket.setTimeout(0);
      socket.pause();
      const frame = buffer.subarray(0, newline).toString('utf8');
      void this.handleFrame(session, frame).then(
        (response) => this.finishResponse(session, socket, response),
        () =>
          this.finishResponse(session, socket, {
            id: '',
            ok: false,
            error: 'broker request failed',
          }),
      );
    });
  }

  private finishResponse(
    session: Session,
    socket: Socket,
    response: BrokerResponse,
  ): void {
    let encoded = JSON.stringify(response);
    if (
      Buffer.byteLength(encoded, 'utf8') + 1 >
      session.policy.policy.maxResultBytes
    ) {
      encoded = JSON.stringify({
        id: response.id.slice(0, 100),
        ok: false,
        error: 'response budget exceeded',
      });
    }
    if (socket.destroyed || !socket.writable) return;
    try {
      // Each connection is exactly one request/response. Explicitly finishing the
      // response lets a well-behaved client observe EOF without half-close races.
      socket.end(`${encoded}\n`);
    } catch {
      socket.destroy();
    }
  }

  private async handleFrame(
    session: Session,
    frame: string,
  ): Promise<BrokerResponse> {
    let request: BrokerRequest;
    try {
      const parsed: unknown = JSON.parse(frame);
      if (!parsed || typeof parsed !== 'object')
        throw new Error('invalid request');
      request = parsed as BrokerRequest;
      if (
        typeof request.id !== 'string' ||
        request.id.length > 100 ||
        typeof request.token !== 'string'
      )
        throw new Error('invalid request');
    } catch {
      return { id: '', ok: false, error: 'invalid request' };
    }
    const reject = (message: string): BrokerResponse => ({
      id: request.id,
      ok: false,
      error: message,
    });
    const supplied = Buffer.from(request.token);
    const expected = Buffer.from(session.token);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected) ||
      session.token === '' ||
      Date.now() > session.expiresAt
    )
      return reject('unauthorized or expired capability');
    if (
      Buffer.byteLength(frame, 'utf8') > session.policy.policy.maxRequestBytes
    )
      return reject('request budget exceeded');
    if (session.requests.has(request.id)) return reject('duplicate request');
    if (++session.messageCount > MAX_MESSAGES)
      return reject('message budget exceeded');
    session.requests.add(request.id);
    try {
      let result: unknown;
      switch (request.method) {
        case 'dispatch':
          result = await this.handler.dispatch(session.policy, request.params);
          break;
        case 'continue_dispatch':
          result = await this.handler.continueDispatch(
            session.policy,
            request.params,
          );
          break;
        case 'await_dispatches':
          result = await this.handler.awaitDispatches(
            session.policy,
            request.params,
          );
          break;
        case 'cancel_dispatch':
          result = await this.handler.cancelDispatch(
            session.policy,
            request.params,
          );
          break;
        default:
          return reject('unsupported method');
      }
      const response: BrokerResponse = { id: request.id, ok: true, result };
      if (
        Buffer.byteLength(JSON.stringify(response), 'utf8') + 1 <=
        session.policy.policy.maxResultBytes
      )
        return response;
      const json = JSON.stringify(result);
      let low = 0;
      let high = Buffer.byteLength(json, 'utf8');
      let bounded: BrokerResponse = {
        id: request.id,
        ok: true,
        result: { truncated: true, summary: '' },
      };
      // JSON escaping means source bytes and wire bytes are not equivalent. Search
      // for the largest UTF-8-safe prefix whose complete response frame fits.
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate: BrokerResponse = {
          id: request.id,
          ok: true,
          result: {
            truncated: true,
            summary: truncateUtf8(json, middle),
          },
        };
        if (
          Buffer.byteLength(JSON.stringify(candidate), 'utf8') + 1 <=
          session.policy.policy.maxResultBytes
        ) {
          bounded = candidate;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      return bounded;
    } catch (error) {
      const raw =
        error instanceof Error ? error.message : 'broker request failed';
      return reject(
        sanitizeErrorMessage(
          raw
            .replaceAll(session.token, '[redacted]')
            .replaceAll(session.socketPath, '[private control path]')
            .replaceAll(
              session.socketDir ?? session.socketPath,
              '[private control path]',
            ),
          'broker request failed',
        ),
      );
    }
  }

  /**
   * Recovery runs in a fresh process with no in-memory Session. Read only the
   * persisted socket path, validate the exact short-path grammar, and remove both
   * artifacts without ever returning or logging the capability token.
   */
  private async cleanupPersisted(runId: string): Promise<void> {
    if (!RUN_ID.test(runId)) return;
    const dir = metaRunControlDir(runId);
    const authFile = join(dir, 'control.json');
    try {
      const raw = await readFile(authFile, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') <= 4_096) {
        const parsed: unknown = JSON.parse(raw);
        const socketPath =
          parsed && typeof parsed === 'object'
            ? (parsed as { socketPath?: unknown }).socketPath
            : undefined;
        if (
          typeof socketPath === 'string' &&
          SHORT_SOCKET_PATH.test(socketPath)
        ) {
          await rm(socketPath, { force: true });
          await rm(dirname(socketPath), { recursive: true, force: true });
        } else if (
          typeof socketPath === 'string' &&
          WINDOWS_PIPE_PATH.test(socketPath)
        ) {
          // Named pipes disappear with their server; validating prevents an attacker
          // from turning persisted auth state into an arbitrary filesystem deletion.
        }
      }
    } catch {
      // Missing/corrupt auth state still permits removal of the run-owned directory.
    }
    if (process.platform !== 'win32') {
      try {
        const entries = await readdir('/tmp', { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || !SHORT_SOCKET_DIRECTORY.test(entry.name))
            continue;
          const candidate = join('/tmp', entry.name);
          const stat = await lstat(candidate);
          if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
          const marker = await readFile(join(candidate, 'run'), 'utf8').catch(
            () => '',
          );
          if (marker.trim() === runId) {
            await rm(candidate, { recursive: true, force: true });
          }
        }
      } catch {
        // Best-effort recovery; validated auth cleanup above remains authoritative.
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}
