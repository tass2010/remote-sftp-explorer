import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  discoverHosts,
  isConcreteAlias,
  MAX_INCLUDE_DEPTH,
  splitConfigWords
} from '../src/hosts/sshConfig.ts';
import { describeHost, parseSshG, validateHost } from '../src/hosts/sshGValidator.ts';
import type { CommandResult, CommandRunner, FileSystemPort } from '../src/ports.ts';

/** An in-memory filesystem keyed by absolute path, with symlink-style aliases for realpath. */
class MemoryFs implements FileSystemPort {
  readonly files = new Map<string, string>();
  readonly links = new Map<string, string>();

  add(filePath: string, contents: string): this {
    this.files.set(path.normalize(filePath), contents);
    return this;
  }

  /** Make `from` resolve to `to`, so Include cycles through links can be exercised. */
  link(from: string, to: string): this {
    this.links.set(path.normalize(from), path.normalize(to));
    return this;
  }

  async readFile(filePath: string): Promise<string> {
    const resolved = await this.realpath(filePath);
    const contents = this.files.get(resolved);
    if (contents === undefined) throw new Error(`ENOENT: ${filePath}`);
    return contents;
  }

  async exists(filePath: string): Promise<boolean> {
    const normalized = path.normalize(filePath);
    return this.files.has(normalized) || this.links.has(normalized);
  }

  async realpath(filePath: string): Promise<string> {
    const normalized = path.normalize(filePath);
    const target = this.links.get(normalized);
    if (target !== undefined) return target;
    if (!this.files.has(normalized)) throw new Error(`ENOENT: ${filePath}`);
    return normalized;
  }

  async listDirectory(directory: string): Promise<string[]> {
    const prefix = path.normalize(directory) + path.sep;
    const names = new Set<string>();
    for (const filePath of [...this.files.keys(), ...this.links.keys()]) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const first = rest.split(path.sep)[0];
      if (first !== undefined && first.length > 0) names.add(first);
    }
    if (names.size === 0) throw new Error(`ENOTDIR: ${directory}`);
    return [...names];
  }
}

const HOME = path.normalize('/home/dev');
const USER_CONFIG = path.join(HOME, '.ssh', 'config');

async function hosts(fs: MemoryFs, systemConfigPath?: string): Promise<string[]> {
  const found = await discoverHosts({
    fs,
    userConfigPath: USER_CONFIG,
    homeDirectory: HOME,
    ...(systemConfigPath === undefined ? {} : { systemConfigPath })
  });
  return found.map((host) => host.alias);
}

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

test('config lines split on whitespace and "="', () => {
  assert.deepEqual(splitConfigWords('Host alpha beta'), ['Host', 'alpha', 'beta']);
  assert.deepEqual(splitConfigWords('Port=2222'), ['Port', '2222']);
  assert.deepEqual(splitConfigWords('  Host   spaced   '), ['Host', 'spaced']);
});

test('quoted values stay one word', () => {
  assert.deepEqual(splitConfigWords('Host "my server" other'), ['Host', 'my server', 'other']);
  assert.deepEqual(splitConfigWords("Host 'single quoted'"), ['Host', 'single quoted']);
});

test('backslash escapes the next character', () => {
  assert.deepEqual(splitConfigWords('Host a\\ b'), ['Host', 'a b']);
});

// ---------------------------------------------------------------------------
// Alias filtering
// ---------------------------------------------------------------------------

test('patterns, negations, and option-like names are not offered as hosts', () => {
  assert.equal(isConcreteAlias('example'), true);
  assert.equal(isConcreteAlias('build-01.internal'), true);

  assert.equal(isConcreteAlias('*'), false, 'a wildcard is a defaults block');
  assert.equal(isConcreteAlias('*.example.com'), false);
  assert.equal(isConcreteAlias('web?'), false);
  assert.equal(isConcreteAlias('!excluded'), false);
  assert.equal(isConcreteAlias('-oProxyCommand=evil'), false, 'ssh would read this as a flag');
  assert.equal(isConcreteAlias(''), false);
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test('concrete aliases are listed in file order without duplicates', async () => {
  const fs = new MemoryFs().add(
    USER_CONFIG,
    [
      '# a comment',
      'Host alpha',
      '  HostName alpha.example.com',
      '',
      'Host beta gamma',
      '  User dev',
      'Host *',
      '  ServerAliveInterval 30',
      'Host alpha',
      '  Port 2222'
    ].join('\n')
  );

  assert.deepEqual(await hosts(fs), ['alpha', 'beta', 'gamma']);
});

test('CRLF line endings are handled', async () => {
  const fs = new MemoryFs().add(USER_CONFIG, 'Host alpha\r\n  User dev\r\nHost beta\r\n');
  assert.deepEqual(await hosts(fs), ['alpha', 'beta']);
});

test('Include pulls in another file, relative to the including file', async () => {
  const fs = new MemoryFs()
    .add(USER_CONFIG, 'Include conf.d/extra\nHost direct')
    .add(path.join(HOME, '.ssh', 'conf.d', 'extra'), 'Host included');

  assert.deepEqual(await hosts(fs), ['included', 'direct']);
});

test('Include expands ~ and globs', async () => {
  const fs = new MemoryFs()
    .add(USER_CONFIG, 'Include ~/.ssh/conf.d/*.conf')
    .add(path.join(HOME, '.ssh', 'conf.d', 'a.conf'), 'Host from-a')
    .add(path.join(HOME, '.ssh', 'conf.d', 'b.conf'), 'Host from-b')
    .add(path.join(HOME, '.ssh', 'conf.d', 'skip.txt'), 'Host not-matched');

  const found = await hosts(fs);
  assert.deepEqual(found.sort(), ['from-a', 'from-b']);
});

test('a missing Include target is ignored rather than fatal', async () => {
  const fs = new MemoryFs().add(USER_CONFIG, 'Include /nowhere/absent\nHost alpha');
  assert.deepEqual(await hosts(fs), ['alpha']);
});

test('an Include cycle terminates instead of recursing forever', async () => {
  const fs = new MemoryFs()
    .add(USER_CONFIG, 'Host alpha\nInclude other')
    .add(path.join(HOME, '.ssh', 'other'), `Host beta\nInclude ${USER_CONFIG}`);

  assert.deepEqual(await hosts(fs), ['alpha', 'beta']);
});

test('a cycle through differently-spelled paths is still detected', async () => {
  // Detection canonicalises with realpath, so two routes to one file count as one visit.
  const fs = new MemoryFs()
    .add(USER_CONFIG, 'Host alpha\nInclude linked')
    .add(path.join(HOME, '.ssh', 'real'), `Host beta\nInclude ${USER_CONFIG}`)
    .link(path.join(HOME, '.ssh', 'linked'), path.join(HOME, '.ssh', 'real'));

  assert.deepEqual(await hosts(fs), ['alpha', 'beta']);
});

test('Include nesting deeper than the limit is refused', async () => {
  const fs = new MemoryFs();
  let contents = 'Host deepest';
  for (let depth = MAX_INCLUDE_DEPTH + 2; depth >= 1; depth -= 1) {
    fs.add(path.join(HOME, '.ssh', `level${depth}`), contents);
    contents = `Include level${depth}`;
  }
  fs.add(USER_CONFIG, contents);

  await assert.rejects(() => hosts(fs), /Include nesting exceeded/);
});

test('the system-wide config contributes hosts too', async () => {
  // Absent from the previous implementation, so organisation-wide aliases were invisible.
  const systemConfig = path.normalize('/ProgramData/ssh/ssh_config');
  const fs = new MemoryFs()
    .add(USER_CONFIG, 'Host mine')
    .add(systemConfig, 'Host corporate-jump');

  assert.deepEqual(await hosts(fs, systemConfig), ['mine', 'corporate-jump']);
});

test('a user alias wins over the same name in the system config', async () => {
  const systemConfig = path.normalize('/ProgramData/ssh/ssh_config');
  const fs = new MemoryFs()
    .add(USER_CONFIG, 'Host shared')
    .add(systemConfig, 'Host shared');

  const found = await discoverHosts({
    fs,
    userConfigPath: USER_CONFIG,
    homeDirectory: HOME,
    systemConfigPath: systemConfig
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.sourceFile, USER_CONFIG);
});

test('a missing user config yields no hosts rather than an error', async () => {
  assert.deepEqual(await hosts(new MemoryFs()), []);
});

// ---------------------------------------------------------------------------
// ssh -G validation
// ---------------------------------------------------------------------------

class ScriptedRunner implements CommandRunner {
  readonly calls: Array<{ executable: string; args: string[] }> = [];
  result: CommandResult | Error = { code: 0, stdout: '', stderr: '' };

  async run(executable: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ executable, args });
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

test('ssh -G output is parsed for the fields we display', () => {
  const parsed = parseSshG(
    ['host example', 'hostname example.internal', 'user deploy', 'port 2222', 'unknownkey x'].join(
      '\n'
    )
  );
  assert.deepEqual(parsed, { hostName: 'example.internal', user: 'deploy', port: 2222 });
});

test('a nonsense port is ignored rather than trusted', () => {
  assert.equal(parseSshG('port 0').port, undefined);
  assert.equal(parseSshG('port 99999').port, undefined);
  assert.equal(parseSshG('port abc').port, undefined);
});

test('garbage output does not throw', () => {
  assert.deepEqual(parseSshG('\n\n   \nnokeyword\n'), {});
});

test('a resolvable alias validates and is described', async () => {
  const runner = new ScriptedRunner();
  runner.result = {
    code: 0,
    stdout: 'hostname example.internal\nuser deploy\nport 2222\n',
    stderr: ''
  };

  const result = await validateHost(runner, 'ssh', 'example');
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(describeHost(result.host), 'deploy@example.internal:2222');
  assert.deepEqual(runner.calls[0]?.args, ['-G', 'example']);
});

test('the default port is left out of the description', async () => {
  const runner = new ScriptedRunner();
  runner.result = { code: 0, stdout: 'hostname h\nuser u\nport 22\n', stderr: '' };
  const result = await validateHost(runner, 'ssh', 'example');
  assert.ok(result.ok);
  assert.equal(describeHost(result.host), 'u@h');
});

test('a non-zero exit marks the host unusable with the reason', async () => {
  const runner = new ScriptedRunner();
  runner.result = { code: 255, stdout: '', stderr: 'Bad configuration option: xyz\n' };

  const result = await validateHost(runner, 'ssh', 'broken');
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.failure.reason, /Bad configuration option/);
});

test('a runner failure is reported rather than thrown', async () => {
  const runner = new ScriptedRunner();
  runner.result = new Error('spawn ENOENT');

  const result = await validateHost(runner, 'ssh', 'example');
  assert.ok(!result.ok);
  assert.match(result.failure.reason, /spawn ENOENT/);
});

test('an option-like alias is refused without running anything', async () => {
  const runner = new ScriptedRunner();
  const result = await validateHost(runner, 'ssh', '-oProxyCommand=evil');
  assert.ok(!result.ok);
  assert.equal(runner.calls.length, 0, 'a hostile alias must never reach the command line');
});
