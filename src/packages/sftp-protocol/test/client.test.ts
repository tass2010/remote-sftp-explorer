import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Extension,
  OpenFlag,
  PacketType,
  SftpClient,
  SftpStatusError,
  StatusCode
} from '../src/index.ts';
import {
  createControllableClock,
  FakeSftpServer,
  type ControllableClock
} from './support/fakeSftpServer.ts';

/** Let queued microtasks settle so in-flight promise chains make progress. */
async function settle(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

async function connect(
  server: FakeSftpServer,
  options: { clock?: ControllableClock; maxInFlight?: number } = {}
): Promise<{ client: SftpClient; clock: ControllableClock }> {
  const clock = options.clock ?? createControllableClock();
  const client = new SftpClient(server.channel, {
    clock,
    ...(options.maxInFlight === undefined ? {} : { maxInFlight: options.maxInFlight })
  });
  await client.handshake();
  return { client, clock };
}

// ---------------------------------------------------------------------------
// Handshake and capabilities
// ---------------------------------------------------------------------------

test('the handshake negotiates version 3 and records advertised extensions', async () => {
  const server = new FakeSftpServer({
    extensions: { [Extension.PosixRename]: '1', [Extension.Fsync]: '1' }
  });
  const { client } = await connect(server);

  assert.equal(client.capabilities.version, 3);
  assert.equal(client.capabilities.posixRename, true);
  assert.equal(client.capabilities.fsync, true);
  assert.equal(client.capabilities.hardlink, false);
});

test('a server negotiating a version other than 3 is refused', async () => {
  const server = new FakeSftpServer({ version: 6 });
  const client = new SftpClient(server.channel, { clock: createControllableClock() });
  await assert.rejects(() => client.handshake(), /only 3 is supported/);
});

// ---------------------------------------------------------------------------
// Correlation and pipelining
// ---------------------------------------------------------------------------

test('responses are matched by request id even when they arrive reversed', async () => {
  const server = new FakeSftpServer();
  server.on(PacketType.Stat, ({ requestId, reader }) => {
    const path = reader.string();
    return FakeSftpServer.attrs(requestId, { size: BigInt(path.length) });
  });
  const { client } = await connect(server);

  // Hold every response, then release them in reverse arrival order.
  server.hold();
  const pending = [
    client.stat('/a'),
    client.stat('/bb'),
    client.stat('/ccc'),
    client.stat('/dddd')
  ];
  await settle();
  server.flush({ reverse: true });

  const results = await Promise.all(pending);
  assert.deepEqual(
    results.map((attributes) => Number(attributes.size)),
    [2, 3, 4, 5],
    'each caller must receive the answer to its own request, not a positional one'
  );
});

test('many requests are genuinely in flight at once', async () => {
  const server = new FakeSftpServer();
  server.on(PacketType.Stat, ({ requestId }) => FakeSftpServer.attrs(requestId, { size: 1n }));
  const { client } = await connect(server, { maxInFlight: 8 });

  server.hold();
  const pending = Array.from({ length: 8 }, (_unused, index) => client.stat(`/f${index}`));
  await settle();

  assert.equal(client.inFlight, 8, 'the window should be saturated');
  server.flush();
  await Promise.all(pending);
});

test('requests beyond the window queue instead of being sent', async () => {
  const server = new FakeSftpServer();
  server.on(PacketType.Stat, ({ requestId }) => FakeSftpServer.attrs(requestId, { size: 1n }));
  const { client } = await connect(server, { maxInFlight: 2 });

  server.hold();
  const pending = Array.from({ length: 5 }, (_unused, index) => client.stat(`/f${index}`));
  await settle();

  assert.equal(client.inFlight, 2);
  assert.equal(server.received.length, 2, 'the server must not see queued requests yet');

  server.flush();
  await settle();
  server.flush();
  await Promise.all(pending);
  assert.equal(server.received.length, 5);
});

test('request ids wrap without colliding with anything still in flight', async () => {
  const server = new FakeSftpServer();
  server.on(PacketType.Stat, ({ requestId }) => FakeSftpServer.attrs(requestId, { size: 1n }));
  const { client } = await connect(server, { maxInFlight: 4 });

  server.hold();
  const pending = Array.from({ length: 4 }, (_unused, index) => client.stat(`/f${index}`));
  await settle();

  const ids = server.received.map((request) => request.requestId);
  assert.equal(new Set(ids).size, ids.length, 'ids in flight must be unique');

  server.flush();
  await Promise.all(pending);
});

// ---------------------------------------------------------------------------
// Timeout handling -- the regression that motivated the rebuild
// ---------------------------------------------------------------------------

test('a response arriving after its request timed out does not affect the next request', async () => {
  // Previously a late response was pushed onto a FIFO and handed to the NEXT unrelated
  // request, which then failed its id check and poisoned the whole session.
  const server = new FakeSftpServer();
  let firstId: number | undefined;
  server.on(PacketType.Stat, ({ requestId, reader }) => {
    const path = reader.string();
    if (path === '/slow') {
      firstId = requestId;
      return undefined; // never answered in time
    }
    return FakeSftpServer.attrs(requestId, { size: 99n });
  });

  const { client, clock } = await connect(server);

  const timedOut = client.stat('/slow');
  await settle();
  clock.advance(30_000);
  await assert.rejects(() => timedOut, /timed out/);

  // The server now finally answers the abandoned request.
  assert.ok(firstId !== undefined);
  server.inject(FakeSftpServer.attrs(firstId, { size: 1n }));
  await settle();

  // A completely unrelated request must still work correctly.
  const attributes = await client.stat('/fast');
  assert.equal(attributes.size, 99n);
  assert.equal(client.closed, false, 'the session must survive a late response');
});

test('a handle arriving late for an abandoned OPEN is closed rather than leaked', async () => {
  const server = new FakeSftpServer();
  let openId: number | undefined;
  server.on(PacketType.Open, ({ requestId }) => {
    openId = requestId;
    return undefined;
  });
  const closed: Uint8Array[] = [];
  server.on(PacketType.Close, ({ requestId, reader }) => {
    closed.push(Uint8Array.from(reader.stringBytes()));
    return FakeSftpServer.status(requestId, StatusCode.Ok);
  });

  const { client, clock } = await connect(server);
  const opening = client.open('/f', OpenFlag.Read);
  await settle();
  clock.advance(30_000);
  await assert.rejects(() => opening, /timed out/);

  // The server eventually hands us a handle for the request we gave up on.
  assert.ok(openId !== undefined);
  server.inject(FakeSftpServer.handle(openId, new Uint8Array([7, 7])));
  await settle();

  assert.equal(closed.length, 1, 'the orphaned handle must be closed');
  assert.deepEqual(closed[0], new Uint8Array([7, 7]));
});

test('a response for an id that was never issued kills the session', async () => {
  const server = new FakeSftpServer();
  const { client } = await connect(server);

  server.inject(FakeSftpServer.attrs(4242, { size: 1n }));
  await settle();

  assert.equal(client.closed, true);
  await assert.rejects(() => client.stat('/x'), /unknown request id 4242/);
});

// ---------------------------------------------------------------------------
// Channel death
// ---------------------------------------------------------------------------

test('channel death rejects every in-flight request', async () => {
  const server = new FakeSftpServer();
  server.on(PacketType.Stat, () => undefined);
  const { client } = await connect(server, { maxInFlight: 4 });

  const pending = [client.stat('/a'), client.stat('/b'), client.stat('/c')];
  await settle();

  server.kill(new Error('ssh exited unexpectedly'));
  for (const promise of pending) {
    await assert.rejects(() => promise, /ssh exited unexpectedly/);
  }
  assert.equal(client.closed, true);
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('readFile reassembles pipelined chunks by offset', async () => {
  const content = new Uint8Array(1000);
  for (let index = 0; index < content.length; index += 1) content[index] = index % 251;

  const server = new FakeSftpServer();
  server.on(PacketType.Open, ({ requestId }) =>
    FakeSftpServer.handle(requestId, new Uint8Array([1]))
  );
  server.on(PacketType.Close, ({ requestId }) => FakeSftpServer.status(requestId, StatusCode.Ok));
  server.on(PacketType.Read, ({ requestId, reader }) => {
    reader.stringBytes();
    const offset = Number(reader.uint64());
    const length = reader.uint32();
    if (offset >= content.length) return FakeSftpServer.status(requestId, StatusCode.Eof);
    return FakeSftpServer.data(requestId, content.subarray(offset, offset + length));
  });

  const { client } = await connect(server);
  const result = await client.readFile('/f', { size: BigInt(content.length) });
  assert.deepEqual(result, content);
});

test('a short read is not mistaken for end of file', async () => {
  // Servers may legitimately return fewer bytes than requested. Treating that as EOF
  // truncates the file.
  const content = new Uint8Array(300).fill(7);
  const server = new FakeSftpServer();
  server.on(PacketType.Open, ({ requestId }) =>
    FakeSftpServer.handle(requestId, new Uint8Array([1]))
  );
  server.on(PacketType.Close, ({ requestId }) => FakeSftpServer.status(requestId, StatusCode.Ok));
  server.on(PacketType.Read, ({ requestId, reader }) => {
    reader.stringBytes();
    const offset = Number(reader.uint64());
    const length = reader.uint32();
    if (offset >= content.length) return FakeSftpServer.status(requestId, StatusCode.Eof);
    // Answer with at most 16 bytes regardless of what was asked for.
    const end = Math.min(offset + Math.min(length, 16), content.length);
    return FakeSftpServer.data(requestId, content.subarray(offset, end));
  });

  const { client } = await connect(server);
  const result = await client.readFile('/f', { size: BigInt(content.length) });
  assert.equal(result.length, 300);
});

test('a failing read surfaces its own error, not a close error', async () => {
  // Closing inside `finally` previously replaced the interesting exception.
  const server = new FakeSftpServer();
  server.on(PacketType.Open, ({ requestId }) =>
    FakeSftpServer.handle(requestId, new Uint8Array([1]))
  );
  server.on(PacketType.Read, ({ requestId }) =>
    FakeSftpServer.status(requestId, StatusCode.PermissionDenied, 'denied')
  );
  server.on(PacketType.Close, ({ requestId }) =>
    FakeSftpServer.status(requestId, StatusCode.Failure, 'close also failed')
  );

  const { client } = await connect(server);
  await assert.rejects(
    () => client.readFile('/f', { size: 10n }),
    (error: unknown) => {
      assert.ok(error instanceof SftpStatusError);
      assert.equal(error.code, StatusCode.PermissionDenied);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------

test('readDirectory pages until EOF and drops dot entries', () => {
  const server = new FakeSftpServer();
  server.on(PacketType.Opendir, ({ requestId }) =>
    FakeSftpServer.handle(requestId, new Uint8Array([2]))
  );
  server.on(PacketType.Close, ({ requestId }) => FakeSftpServer.status(requestId, StatusCode.Ok));

  let page = 0;
  server.on(PacketType.Readdir, ({ requestId }) => {
    page += 1;
    if (page === 1) {
      return FakeSftpServer.name(requestId, [
        { filename: '.', attributes: { permissions: 0o040755 } },
        { filename: '..', attributes: { permissions: 0o040755 } },
        { filename: 'alpha', attributes: { permissions: 0o100644 } }
      ]);
    }
    if (page === 2) {
      return FakeSftpServer.name(requestId, [
        { filename: 'beta', attributes: { permissions: 0o040755 } }
      ]);
    }
    return FakeSftpServer.status(requestId, StatusCode.Eof);
  });

  return connect(server).then(async ({ client }) => {
    const batches: string[][] = [];
    const entries = await client.readDirectory('/dir', {
      onBatch: (batch) => batches.push(batch.map((entry) => entry.filename))
    });

    assert.deepEqual(entries.map((entry) => entry.filename), ['alpha', 'beta']);
    assert.deepEqual(entries.map((entry) => entry.type), ['file', 'directory']);
    assert.deepEqual(batches, [['alpha'], ['beta']], 'batches stream as they arrive');
  });
});

test('a directory listing failure closes the directory handle', async () => {
  const server = new FakeSftpServer();
  server.on(PacketType.Opendir, ({ requestId }) =>
    FakeSftpServer.handle(requestId, new Uint8Array([3]))
  );
  server.on(PacketType.Readdir, ({ requestId }) =>
    FakeSftpServer.status(requestId, StatusCode.PermissionDenied, 'nope')
  );
  let closes = 0;
  server.on(PacketType.Close, ({ requestId }) => {
    closes += 1;
    return FakeSftpServer.status(requestId, StatusCode.Ok);
  });

  const { client } = await connect(server);
  await assert.rejects(() => client.readDirectory('/dir'), /PERMISSION_DENIED/);
  assert.equal(closes, 1, 'the handle must be released even on failure');
});

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

test('server failures carry their status code for domain mapping', async () => {
  const server = new FakeSftpServer();
  server.on(PacketType.Stat, ({ requestId }) =>
    FakeSftpServer.status(requestId, StatusCode.NoSuchFile, 'no such file')
  );
  const { client } = await connect(server);

  await assert.rejects(
    () => client.stat('/missing'),
    (error: unknown) => {
      assert.ok(error instanceof SftpStatusError);
      assert.equal(error.code, StatusCode.NoSuchFile);
      assert.equal(error.is(StatusCode.NoSuchFile), true);
      assert.match(error.message, /NO_SUCH_FILE/);
      return true;
    }
  );
});

test('cancellation abandons the request and rejects the caller', async () => {
  const server = new FakeSftpServer();
  server.on(PacketType.Stat, () => undefined);
  const { client } = await connect(server);

  const controller = new AbortController();
  const pending = client.stat('/slow', controller.signal);
  await settle();
  controller.abort();

  await assert.rejects(() => pending, /cancelled/);
  assert.equal(client.closed, false);
});
