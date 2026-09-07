import type { PromptKind } from '../ports.ts';

/**
 * Decide what kind of answer OpenSSH is asking for.
 *
 * This lives in TypeScript rather than in the Rust helper (ADR-0003) because prompt wording
 * varies across OpenSSH versions and PAM modules, and this is the piece most likely to need
 * adjustment. Here it is covered by table-driven tests that run on every PR; in Rust each
 * change would need a Windows cross-compile and a new signed binary.
 */

const CONFIRM_PATTERNS: RegExp[] = [
  /\(yes\/no(?:\/\[fingerprint\])?\)\s*\?\s*$/iu,
  /are you sure you want to continue connecting/iu
];

const SECRET_PATTERNS: RegExp[] = [
  /password\s*:?\s*$/iu,
  /\bpassword\b/iu,
  /passphrase/iu,
  /verification code/iu,
  /one[- ]time password/iu,
  /\botp\b/iu,
  /\bpin\b/iu,
  /duo/iu,
  /token/iu
];

export function classifyPrompt(promptText: string, envHint?: string): PromptKind {
  const hint = envHint?.trim().toLowerCase();
  if (hint === 'confirm') return 'confirm';

  const text = promptText.trim();
  for (const pattern of CONFIRM_PATTERNS) {
    if (pattern.test(text)) return 'confirm';
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) return 'secret';
  }

  // `text` is only honoured as an explicit hint, never inferred. Defaulting to `secret` fails
  // closed: showing a credential in an unmasked box is a worse mistake than masking something
  // that did not need it.
  if (hint === 'text') return 'text';
  return 'secret';
}
