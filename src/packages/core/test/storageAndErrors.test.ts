import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SftpStatusError, StatusCode } from '@remote-sftp-explorer/sftp-protocol';
import { classifyRemoteError } from '../src/fs/errorClassification.ts';
import {
  DirectoryHistoryStore,
  FavoritesStore,
  HISTORY_LIMIT
} from '../src/storage/persistedState.ts';
import {
  formatModified,
  formatSize,
  parseBrowserMessage,
  resolveDisplayPath,
  sortBrowserEntries,
  type BrowserEntry,
  type SortOrder
} from '../src/browser/browserProtocol.ts';
import type { Memento } from '../src/ports.ts';

class MemoryMemento implements Memento {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

const status = (code: number, message = ''): SftpStatusError =>
  new SftpStatusError({ code, message, languageTag: '' });

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test('server status codes map onto distinct failure kinds', () => {
  assert.equal(classifyRemoteError(status(StatusCode.NoSuchFile)).kind, 'not-found');
  assert.equal(classifyRemoteError(status(StatusCode.PermissionDenied)).kind, 'no-permissions');
  assert.equal(classifyRemoteError(status(StatusCode.OpUnsupported)).kind, 'unsupported');
  assert.equal(classifyRemoteError(status(StatusCode.ConnectionLost)).kind, 'connection-lost');
  assert.equal(classifyRemoteError(status(StatusCode.NoConnection)).kind, 'connection-lost');
});

test('the catch-all FAILURE code is refined using the server message', () => {
  // v3 has no dedicated code for these, so the server's own words are the only signal.
  assert.equal(classifyRemoteError(status(StatusCode.Failure, 'File exists')).kind, 'already-exists');
  assert.equal(
    classifyRemoteError(status(StatusCode.Failure, 'Not a directory')).kind,
    'not-a-directory'
  );
  assert.equal(
    classifyRemoteError(status(StatusCode.Failure, 'Is a directory')).kind,
    'is-a-directory'
  );
  assert.equal(classifyRemoteError(status(StatusCode.Failure, 'something odd')).kind, 'unknown');
});

test('cancellation and conflict are distinguished from real failures', () => {
  const aborted = new Error('cancelled');
  aborted.name = 'AbortedError';
  assert.equal(classifyRemoteError(aborted).kind, 'cancelled');

  const conflict = new Error('changed on the server');
  conflict.name = 'RemoteConflictError';
  assert.equal(classifyRemoteError(conflict).kind, 'conflict');
});

test('a dead ssh process is reported as a lost connection', () => {
  const exit = new Error('ssh exited with code 255.');
  exit.name = 'SshExitError';
  assert.equal(classifyRemoteError(exit).kind, 'connection-lost');
});

test('the path is included in the message when known', () => {
  const classified = classifyRemoteError(status(StatusCode.NoSuchFile), '/home/dev/gone.txt');
  assert.match(classified.message, /\/home\/dev\/gone\.txt/);
});

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

test('favourites round-trip and are scoped to their host', async () => {
  const store = new FavoritesStore(new MemoryMemento());
  await store.add({ alias: 'alpha', path: '/srv/app', type: 'directory', name: 'app' });
  await store.add({ alias: 'beta', path: '/etc/hosts', type: 'file', name: 'hosts' });

  assert.equal(store.all().length, 2);
  assert.deepEqual(
    store.forAlias('alpha').map((favorite) => favorite.path),
    ['/srv/app']
  );
});

test('re-adding the same path updates rather than duplicates it', async () => {
  const store = new FavoritesStore(new MemoryMemento());
  await store.add({ alias: 'alpha', path: '/srv/app', type: 'directory', name: 'old' });
  await store.add({ alias: 'alpha', path: '/srv/app', type: 'directory', name: 'new' });

  assert.equal(store.all().length, 1);
  assert.equal(store.all()[0]?.name, 'new');
});

test('removing a favourite leaves the others alone', async () => {
  const store = new FavoritesStore(new MemoryMemento());
  await store.add({ alias: 'a', path: '/one', type: 'file', name: 'one' });
  await store.add({ alias: 'a', path: '/two', type: 'file', name: 'two' });

  await store.remove('a', '/one');
  assert.deepEqual(store.all().map((favorite) => favorite.path), ['/two']);
});

test('malformed stored favourites are dropped rather than crashing the view', () => {
  // Global state is a plaintext file that an older version, or a person, may have written.
  const memento = new MemoryMemento();
  memento.values.set('remoteSftp.favorites.v1', {
    version: 1,
    items: [
      { alias: 'a', path: '/good', type: 'file', name: 'good' },
      { alias: '', path: '/bad', type: 'file', name: 'no alias' },
      { alias: 'a', path: 'relative', type: 'file', name: 'not absolute' },
      { alias: 'a', path: '/x', type: 'weird', name: 'bad type' },
      null,
      'not an object'
    ]
  });

  const store = new FavoritesStore(memento);
  assert.deepEqual(store.all().map((favorite) => favorite.path), ['/good']);
});

test('state written by a future version is ignored rather than misread', () => {
  const memento = new MemoryMemento();
  memento.values.set('remoteSftp.favorites.v1', { version: 2, items: [{ anything: true }] });
  assert.deepEqual(new FavoritesStore(memento).all(), []);
});

// ---------------------------------------------------------------------------
// Directory history
// ---------------------------------------------------------------------------

test('history keeps the most recent first without duplicates', async () => {
  const store = new DirectoryHistoryStore(new MemoryMemento());
  await store.record('alpha', '/srv');
  await store.record('alpha', '/var/log');
  await store.record('alpha', '/srv');

  assert.deepEqual(store.forAlias('alpha'), ['/srv', '/var/log']);
});

test('history is capped so global state cannot grow forever', async () => {
  const store = new DirectoryHistoryStore(new MemoryMemento());
  for (let index = 0; index < HISTORY_LIMIT + 10; index += 1) {
    await store.record('alpha', `/dir${index}`);
  }

  const history = store.forAlias('alpha');
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history[0], `/dir${HISTORY_LIMIT + 9}`, 'the newest entry is first');
});

test('history is per host', async () => {
  const store = new DirectoryHistoryStore(new MemoryMemento());
  await store.record('alpha', '/only-alpha');
  await store.record('beta', '/only-beta');

  assert.deepEqual(store.forAlias('alpha'), ['/only-alpha']);
  assert.deepEqual(store.forAlias('beta'), ['/only-beta']);
});

test('clearing removes one host or everything', async () => {
  const store = new DirectoryHistoryStore(new MemoryMemento());
  await store.record('alpha', '/a');
  await store.record('beta', '/b');

  await store.clear('alpha');
  assert.deepEqual(store.forAlias('alpha'), []);
  assert.deepEqual(store.forAlias('beta'), ['/b']);

  await store.clear();
  assert.deepEqual(store.forAlias('beta'), []);
});

test('an unusable path is not recorded', async () => {
  const store = new DirectoryHistoryStore(new MemoryMemento());
  await store.record('alpha', 'not-absolute');
  await store.record('alpha', '/has\0nul');
  assert.deepEqual(store.forAlias('alpha'), []);
});

// ---------------------------------------------------------------------------
// Webview message contract
// ---------------------------------------------------------------------------

test('only allowlisted messages are accepted', () => {
  assert.deepEqual(parseBrowserMessage({ type: 'refresh' }), { type: 'refresh' });
  assert.deepEqual(parseBrowserMessage({ type: 'navigate', path: '/srv/app' }), {
    type: 'navigate',
    path: '/srv/app'
  });

  // A compromised webview must not reach an operation we never exposed.
  assert.equal(parseBrowserMessage({ type: 'deleteEverything', path: '/' }), undefined);
  assert.equal(parseBrowserMessage({ type: 'navigate' }), undefined, 'path is required');
  assert.equal(parseBrowserMessage({ type: 'navigate', path: 42 }), undefined);
  assert.equal(parseBrowserMessage(null), undefined);
  assert.equal(parseBrowserMessage('refresh'), undefined);
});

test('paths from the webview are normalised and traversal is resolved away', () => {
  assert.deepEqual(parseBrowserMessage({ type: 'navigate', path: '/srv//app/..' }), {
    type: 'navigate',
    path: '/srv'
  });
  assert.equal(parseBrowserMessage({ type: 'navigate', path: 'relative/path' }), undefined);
  assert.equal(parseBrowserMessage({ type: 'openEntry', path: '/has\0nul' }), undefined);
});

test('sizes and timestamps render for display', () => {
  assert.equal(formatSize(0n, 'file'), '0 B');
  assert.equal(formatSize(1023n, 'file'), '1023 B');
  assert.equal(formatSize(2048n, 'file'), '2.0 KB');
  assert.equal(formatSize(5n * 1024n * 1024n, 'file'), '5.0 MB');
  assert.equal(formatSize(4096n, 'directory'), '', 'directory sizes are meaningless here');

  assert.equal(formatModified(0), '');
  assert.equal(formatModified(undefined), '');
  assert.match(formatModified(1_700_000_000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

// ---------------------------------------------------------------------------
// Which path the path field shows
// ---------------------------------------------------------------------------

test('the browsed directory is what the path field shows', () => {
  assert.equal(
    resolveDisplayPath({
      currentPath: '/srv/app/config',
      sessionRoot: '/home/dev',
      lastRoot: '/home/dev'
    }),
    '/srv/app/config'
  );
});

test('before the first navigation the path field shows the session root', () => {
  assert.equal(
    resolveDisplayPath({ currentPath: undefined, sessionRoot: '/home/dev', lastRoot: undefined }),
    '/home/dev'
  );
});

test('during a reconnect the path field keeps the remembered root', () => {
  // The live session is briefly gone while reconnecting; blanking the field then would make
  // the panel look broken at exactly the moment the user is watching it.
  assert.equal(
    resolveDisplayPath({ currentPath: undefined, sessionRoot: undefined, lastRoot: '/home/dev' }),
    '/home/dev'
  );
});

test('a browsed directory survives losing the session', () => {
  assert.equal(
    resolveDisplayPath({ currentPath: '/var/log', sessionRoot: undefined, lastRoot: '/home/dev' }),
    '/var/log'
  );
});

test('with nothing known the path is empty rather than a false "/"', () => {
  // Showing "/" would claim to be at the filesystem root while listing nothing at all.
  assert.equal(
    resolveDisplayPath({ currentPath: undefined, sessionRoot: undefined, lastRoot: undefined }),
    ''
  );
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function entry(
  name: string,
  overrides: Partial<BrowserEntry> = {}
): BrowserEntry {
  return {
    name,
    path: `/dir/${name}`,
    type: 'file',
    sizeLabel: '',
    modifiedLabel: '',
    sizeBytes: 0,
    mtime: 0,
    canFavorite: true,
    ...overrides
  };
}

const order = (key: SortOrder['key'], direction: SortOrder['direction']): SortOrder => ({
  key,
  direction
});

const names = (rows: BrowserEntry[]): string[] => rows.map((row) => row.name);

test('directories stay first whatever the key and direction', () => {
  // Sorting folders in among the files by size or date makes a listing much harder to scan.
  const rows = [
    entry('big.txt', { sizeBytes: 9000 }),
    entry('zeta', { type: 'directory' }),
    entry('alpha.txt', { sizeBytes: 10 }),
    entry('beta', { type: 'directory' })
  ];

  for (const candidate of [
    order('name', 'asc'),
    order('name', 'desc'),
    order('size', 'asc'),
    order('size', 'desc'),
    order('modified', 'desc')
  ]) {
    const sorted = sortBrowserEntries(rows, candidate);
    const directoryCount = sorted.filter((row) => row.type === 'directory').length;
    assert.deepEqual(
      names(sorted).slice(0, directoryCount).sort(),
      ['beta', 'zeta'],
      `${candidate.key}/${candidate.direction} moved a directory below a file`
    );
  }
});

test('sorting by name reverses with the direction', () => {
  const rows = [entry('c.txt'), entry('a.txt'), entry('b.txt')];
  assert.deepEqual(names(sortBrowserEntries(rows, order('name', 'asc'))), [
    'a.txt',
    'b.txt',
    'c.txt'
  ]);
  assert.deepEqual(names(sortBrowserEntries(rows, order('name', 'desc'))), [
    'c.txt',
    'b.txt',
    'a.txt'
  ]);
});

test('names sort numerically, so file10 follows file9', () => {
  const rows = [entry('file10.txt'), entry('file9.txt'), entry('file1.txt')];
  assert.deepEqual(names(sortBrowserEntries(rows, order('name', 'asc'))), [
    'file1.txt',
    'file9.txt',
    'file10.txt'
  ]);
});

test('sorting by size uses the byte count, not its label', () => {
  // "9.0 KB" sorts before "10 B" as text, which is why the raw value travels with the label.
  const rows = [
    entry('small.txt', { sizeBytes: 10, sizeLabel: '10 B' }),
    entry('large.txt', { sizeBytes: 9216, sizeLabel: '9.0 KB' })
  ];
  assert.deepEqual(names(sortBrowserEntries(rows, order('size', 'asc'))), [
    'small.txt',
    'large.txt'
  ]);
  assert.deepEqual(names(sortBrowserEntries(rows, order('size', 'desc'))), [
    'large.txt',
    'small.txt'
  ]);
});

test('sorting by modified time uses the timestamp', () => {
  const rows = [
    entry('old.txt', { mtime: 1000 }),
    entry('new.txt', { mtime: 9000 }),
    entry('mid.txt', { mtime: 5000 })
  ];
  assert.deepEqual(names(sortBrowserEntries(rows, order('modified', 'desc'))), [
    'new.txt',
    'mid.txt',
    'old.txt'
  ]);
});

test('equal keys fall back to the name, in both directions', () => {
  // Without a tiebreaker two same-sized files would swap places between listings for no
  // visible reason.
  const rows = [entry('b.txt', { sizeBytes: 5 }), entry('a.txt', { sizeBytes: 5 })];
  assert.deepEqual(names(sortBrowserEntries(rows, order('size', 'asc'))), ['a.txt', 'b.txt']);
  assert.deepEqual(names(sortBrowserEntries(rows, order('size', 'desc'))), ['a.txt', 'b.txt']);
});

test('a missing timestamp sorts as the oldest rather than throwing', () => {
  const rows = [entry('dated.txt', { mtime: 500 }), entry('undated.txt', { mtime: 0 })];
  assert.deepEqual(names(sortBrowserEntries(rows, order('modified', 'asc'))), [
    'undated.txt',
    'dated.txt'
  ]);
});

test('sorting does not mutate the array it was given', () => {
  const rows = [entry('b.txt'), entry('a.txt')];
  sortBrowserEntries(rows, order('name', 'asc'));
  assert.deepEqual(names(rows), ['b.txt', 'a.txt']);
});
