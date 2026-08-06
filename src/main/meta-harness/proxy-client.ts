import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { sanitizeErrorMessage } from '../security/sanitize-error';
import type { BrokerMethod, BrokerResponse } from './control-broker';

export interface BrokerAuth {
  socketPath: string;
  token: string;
}

export interface BrokerCallOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

function safeBrokerError(message: string, auth: BrokerAuth): string {
  return sanitizeErrorMessage(
    message
      .replaceAll(auth.token, '[redacted]')
      .replaceAll(auth.socketPath, '[private control path]'),
    'control request failed',
  );
}

function parseResponse(
  frame: Buffer,
  requestId: string,
  auth: BrokerAuth,
): { result?: unknown; error?: Error } {
  try {
    const parsed: unknown = JSON.parse(frame.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid response');
    }
    const response = parsed as Partial<BrokerResponse>;
    if (response.id !== requestId || typeof response.ok !== 'boolean') {
      throw new Error('invalid response');
    }
    if (!response.ok) {
      const message =
        typeof response.error === 'string'
          ? safeBrokerError(response.error, auth)
          : 'control request failed';
      return { error: new Error(message) };
    }
    return { result: response.result };
  } catch {
    return { error: new Error('invalid control response') };
  }
}

/**
 * Send one newline-delimited broker request without half-closing the connection.
 * The asynchronous broker handler owns response completion, so an early client FIN
 * would otherwise make its eventual write race with the socket's automatic teardown.
 */
export function callBroker(
  auth: BrokerAuth,
  method: BrokerMethod,
  params: unknown,
  options: BrokerCallOptions = {},
): Promise<unknown> {
  if (!auth.socketPath || !auth.token) {
    return Promise.reject(new Error('invalid private control configuration'));
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0
  ) {
    return Promise.reject(new Error('invalid broker call options'));
  }

  const id = randomUUID();
  let request: string;
  try {
    request = `${JSON.stringify({
      id,
      token: auth.token,
      method,
      params,
    })}\n`;
  } catch {
    return Promise.reject(new Error('invalid control request'));
  }

  return new Promise((resolve, reject) => {
    let socket: Socket;
    try {
      socket = connect(auth.socketPath);
    } catch {
      reject(new Error('control service unavailable'));
      return;
    }

    let response = Buffer.alloc(0);
    let settled = false;
    const deadline = setTimeout(() => {
      settle(new Error('control request timed out'));
    }, timeoutMs);
    deadline.unref();

    const settle = (error?: Error, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      // The first complete response is authoritative. Destroying here also ignores
      // trailing frames from a compromised or malfunctioning peer.
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const unavailable = (): void => {
      settle(new Error('control service unavailable'));
    };

    socket.once('connect', () => {
      // Deliberately do not call end(): the broker may await child work before it can
      // answer and must retain a writable response side for that entire interval.
      socket.write(request, (error) => {
        if (error) unavailable();
      });
    });
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      const newline = chunk.indexOf(10);
      const part = newline >= 0 ? chunk.subarray(0, newline) : chunk;
      if (response.length + part.length > maxResponseBytes) {
        settle(new Error('control response too large'));
        return;
      }
      response = Buffer.concat([response, part]);
      if (newline < 0) return;

      const parsed = parseResponse(response, id, auth);
      settle(parsed.error, parsed.result);
    });
    socket.on('error', unavailable);
    socket.on('end', unavailable);
    socket.on('close', unavailable);
  });
}
