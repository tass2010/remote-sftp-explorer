import path from 'node:path';
import type { FileSystemPort } from '../ports.ts';

export const MAX_INCLUDE_DEPTH = 32;

export interface SshHost {
  alias: string;
  /** Stable per-alias identifier used in remote URIs. */
  sourceFile: string;
}

export interface HostDiscoveryOptions {
  fs: FileSystemPort;
  /** Usually `%USERPROFILE%\.ssh\config`. */
  userConfigPath: string;
  /** Usually `%ProgramData%\ssh\ssh_config`. Absent on some systems, which is fine. */
  systemConfigPath?: string | undefined;
  homeDirectory: string;
}

/**
 * Split an SSH config line into words, honouring quotes and backslash escapes.
 *
 * `Host "my server" other` is two aliases, not three words.
 */
export function splitConfigWords(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let started = false;

  for (const character of line) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character) || character === '=') {
      if (started) {
        words.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

/**
 * Is this a concrete host we can offer, rather than a pattern or a defaults block?
 *
 * Excluded:
 *   - anything with `*` or `?`, which is a pattern for applying settings, not a destination
 *   - `!`-negated patterns
 *   - anything starting with `-`, which ssh would read as an option
 */
export function isConcreteAlias(alias: string): boolean {
  if (alias.length === 0) return false;
  if (alias.startsWith('!') || alias.startsWith('-')) return false;
  if (alias.includes('*') || alias.includes('?')) return false;
  if (alias.includes('\0') || /\s/u.test(alias)) return false;
  return true;
}

function expandTilde(value: string, homeDirectory: string): string {
  if (value === '~') return homeDirectory;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDirectory, value.slice(2));
  }
  return value;
}

function globToRegExp(segment: string): RegExp {
  let pattern = '';
  for (const character of segment) {
    if (character === '*') pattern += '[^/\\\\]*';
    else if (character === '?') pattern += '[^/\\\\]';
    else pattern += character.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${pattern}$`, process.platform === 'win32' ? 'iu' : 'u');
}

async function expandGlob(fs: FileSystemPort, pattern: string): Promise<string[]> {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return (await fs.exists(pattern)) ? [pattern] : [];
  }
  const segments = pattern.split(/[/\\]/u);
  let candidates = [segments[0] === '' ? '/' : segments[0] ?? ''];

  for (const segment of segments.slice(1)) {
    if (segment === '') continue;
    const next: string[] = [];
    if (!segment.includes('*') && !segment.includes('?')) {
      for (const base of candidates) next.push(path.join(base, segment));
    } else {
      const matcher = globToRegExp(segment);
      for (const base of candidates) {
        let entries: string[];
        try {
          entries = await fs.listDirectory(base);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (matcher.test(entry)) next.push(path.join(base, entry));
        }
      }
    }
    candidates = next;
  }

  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await fs.exists(candidate)) existing.push(candidate);
  }
  return existing.sort();
}

interface ParseState {
  fs: FileSystemPort;
  homeDirectory: string;
  aliases: Map<string, string>;
  visited: Set<string>;
}

async function parseFile(state: ParseState, filePath: string, depth: number): Promise<void> {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(`SSH config Include nesting exceeded ${MAX_INCLUDE_DEPTH} levels.`);
  }

  // Canonicalise before recording: two Includes reaching the same file by different routes
  // are the same file, and following the cycle would not terminate.
  let canonical: string;
  try {
    canonical = await state.fs.realpath(filePath);
  } catch {
    return;
  }
  if (state.visited.has(canonical)) return;
  state.visited.add(canonical);

  let text: string;
  try {
    text = await state.fs.readFile(filePath);
  } catch {
    return;
  }

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const words = splitConfigWords(line);
    const keyword = words[0]?.toLowerCase();
    if (keyword === undefined) continue;

    if (keyword === 'host') {
      for (const alias of words.slice(1)) {
        if (isConcreteAlias(alias) && !state.aliases.has(alias)) {
          state.aliases.set(alias, filePath);
        }
      }
      continue;
    }

    if (keyword === 'include') {
      for (const rawPattern of words.slice(1)) {
        const expanded = expandTilde(rawPattern, state.homeDirectory);
        // A relative Include resolves against the directory of the including file.
        const absolute = path.isAbsolute(expanded)
          ? expanded
          : path.join(path.dirname(filePath), expanded);
        for (const match of await expandGlob(state.fs, absolute)) {
          await parseFile(state, match, depth + 1);
        }
      }
    }
  }
}

/**
 * Enumerate the concrete host aliases the user has configured.
 *
 * This parse exists only to build a menu. Connecting always hands the original alias back to
 * OpenSSH, so Match, IdentityFile, ProxyJump, certificates, and everything else stay OpenSSH's
 * business -- we deliberately do not interpret them.
 */
export async function discoverHosts(options: HostDiscoveryOptions): Promise<SshHost[]> {
  const state: ParseState = {
    fs: options.fs,
    homeDirectory: options.homeDirectory,
    aliases: new Map(),
    visited: new Set()
  };

  // User config first: its aliases win when a name appears in both.
  await parseFile(state, options.userConfigPath, 0);
  if (options.systemConfigPath !== undefined) {
    await parseFile(state, options.systemConfigPath, 0);
  }

  return [...state.aliases.entries()].map(([alias, sourceFile]) => ({ alias, sourceFile }));
}
