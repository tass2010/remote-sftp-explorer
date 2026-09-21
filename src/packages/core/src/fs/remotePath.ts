import posix from 'node:path/posix';

export const MAX_REMOTE_PATH_LENGTH = 4096;

/**
 * Normalise an absolute POSIX path, rejecting anything that cannot safely become one.
 *
 * Remote paths only ever travel inside SFTP packets, never a shell command line, so the risk
 * here is not injection but ambiguity: a relative path, an embedded NUL, or a traversal
 * sequence that resolves somewhere the user did not intend.
 */
export function normalizeRemotePath(value: string): string {
  if (value.length === 0) throw new Error('A remote path cannot be empty.');
  if (value.length > MAX_REMOTE_PATH_LENGTH) {
    throw new Error(`A remote path cannot exceed ${MAX_REMOTE_PATH_LENGTH} characters.`);
  }
  if (value.includes('\0')) throw new Error('A remote path cannot contain a NUL byte.');
  if (!value.startsWith('/')) throw new Error(`A remote path must be absolute: ${value}`);
  const normalized = posix.normalize(value);
  // normalize() leaves a trailing slash on "/a/b/"; strip it so paths compare by identity.
  return normalized.length > 1 && normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;
}

export function parentRemotePath(value: string): string {
  return posix.dirname(normalizeRemotePath(value));
}

export function remoteBaseName(value: string): string {
  return posix.basename(normalizeRemotePath(value));
}

export function joinRemotePath(parent: string, name: string): string {
  assertValidName(name);
  const base = normalizeRemotePath(parent);
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

/** A single path segment, as typed by a user for a rename or a new file. */
export function assertValidName(name: string): void {
  if (name.length === 0) throw new Error('A name cannot be empty.');
  if (name === '.' || name === '..') throw new Error(`"${name}" is not a usable name.`);
  if (name.includes('/')) throw new Error('A name cannot contain "/".');
  if (name.includes('\0')) throw new Error('A name cannot contain a NUL byte.');
}

/** True when `candidate` is `root` or sits beneath it. Used to keep deletes in bounds. */
export function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeRemotePath(root);
  const normalizedCandidate = normalizeRemotePath(candidate);
  if (normalizedRoot === '/') return true;
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

/**
 * Explain what is wrong with a name the user typed, or return undefined when nothing is.
 *
 * This runs while an input box validates, so the string it returns is what the user reads as
 * they type. The duplicate check is a convenience rather than a guarantee -- the directory can
 * change between the keystroke and the create -- so the operation itself still has to rely on
 * the server refusing a name that is already taken.
 */
export function describeNameProblem(
  name: string,
  options: { taken?: Iterable<string> | undefined; current?: string | undefined } = {}
): string | undefined {
  try {
    assertValidName(name);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  // Renaming something to what it is already called is a no-op, not a collision with itself.
  if (options.current !== undefined && name === options.current) return undefined;
  for (const existing of options.taken ?? []) {
    if (existing === name) return `"${name}" already exists in this folder.`;
  }
  return undefined;
}

/**
 * The span of a filename to preselect when it is offered for editing.
 *
 * Everything before the final dot, so renaming does not mean retyping the extension. A leading
 * dot is part of the name rather than an extension marker, so `.bashrc` selects whole -- the
 * alternative would preselect nothing and leave the user staring at an apparently inert box.
 */
export function nameStemRange(value: string): [number, number] | undefined {
  if (value.length === 0) return undefined;
  const dot = value.lastIndexOf('.');
  return dot > 0 ? [0, dot] : [0, value.length];
}
