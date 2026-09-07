import { SftpProtocolError } from '../wire/errors.ts';
import type { Clock } from './platform.ts';
import type { DecodedResponse } from '../packets.ts';

export interface PendingRequest {
  requestId: number;
  /** For diagnostics, and to recognise an abandoned OPEN whose HANDLE arrives late. */
  type: number;
  resolve(response: DecodedResponse): void;
  reject(error: Error): void;
  timer: unknown;
}

export interface AbandonedRequest {
  type: number;
  abandonedAt: number;
}

const MAX_REQUEST_ID = 0xffff_ffff;

/**
 * Tracks in-flight request ids and the ids of requests we have given up on.
 *
 * Two properties matter and neither existed before:
 *
 *  1. Responses are matched by id through a map, so they may arrive in any order. The previous
 *     implementation popped a FIFO queue and then asserted the id happened to match, which is
 *     only correct when exactly one request is ever outstanding.
 *
 *  2. A timed-out id is NOT immediately reusable. It moves to `abandoned`, so a late response
 *     is recognised and discarded instead of being handed to the next unrelated request --
 *     which previously poisoned the session with a misleading "expected id X, received Y".
 */
export class RequestRegistry {
  readonly #pending = new Map<number, PendingRequest>();
  readonly #abandoned = new Map<number, AbandonedRequest>();
  readonly #clock: Clock;
  #nextId = 1;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  get inFlight(): number {
    return this.#pending.size;
  }

  get abandonedCount(): number {
    return this.#abandoned.size;
  }

  /** Next free id, wrapping at 32 bits and skipping anything in flight or abandoned. */
  allocateId(): number {
    for (let attempt = 0; attempt <= MAX_REQUEST_ID; attempt += 1) {
      const candidate = this.#nextId;
      this.#nextId = this.#nextId >= MAX_REQUEST_ID ? 1 : this.#nextId + 1;
      if (!this.#pending.has(candidate) && !this.#abandoned.has(candidate)) return candidate;
    }
    throw new SftpProtocolError('no free SFTP request id available');
  }

  add(request: PendingRequest): void {
    this.#pending.set(request.requestId, request);
  }

  take(requestId: number): PendingRequest | undefined {
    const request = this.#pending.get(requestId);
    if (request !== undefined) {
      this.#pending.delete(requestId);
      this.#clock.clearTimeout(request.timer);
    }
    return request;
  }

  /** Move a timed-out request out of flight without freeing its id yet. */
  abandon(requestId: number): PendingRequest | undefined {
    const request = this.#pending.get(requestId);
    if (request === undefined) return undefined;
    this.#pending.delete(requestId);
    this.#clock.clearTimeout(request.timer);
    this.#abandoned.set(requestId, { type: request.type, abandonedAt: this.#clock.now() });
    return request;
  }

  /** Recognise (and free) a late response for a request we already gave up on. */
  claimAbandoned(requestId: number): AbandonedRequest | undefined {
    const record = this.#abandoned.get(requestId);
    if (record !== undefined) this.#abandoned.delete(requestId);
    return record;
  }

  /** Reject everything outstanding -- the channel died. */
  failAll(error: Error): void {
    for (const request of [...this.#pending.values()]) {
      this.#pending.delete(request.requestId);
      this.#clock.clearTimeout(request.timer);
      request.reject(error);
    }
    this.#abandoned.clear();
  }
}
