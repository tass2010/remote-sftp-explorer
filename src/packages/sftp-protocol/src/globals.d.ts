/**
 * Minimal ambient declarations for the two WHATWG encoding globals this package uses.
 *
 * `TextEncoder` and `TextDecoder` are standard and present in every runtime we target, but
 * their type declarations live in the DOM and node libs -- both of which this package
 * deliberately excludes (ADR-0002). Declaring just these two keeps `types: []` intact while
 * avoiding a hand-rolled UTF-8 codec, which would be far more likely to harbour a bug than
 * the platform's.
 */
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: Uint8Array): string;
}
