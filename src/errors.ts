/**
 * Error taxonomy.
 *
 * The governing rule: a failed *probe* is data, a failed *load* is an error.
 *
 * - A sysctl key that does not exist is not an error. It is reported as
 *   `Undetectable` with the reason attached. That is the whole point of this
 *   package.
 * - A native addon that will not load IS an error and is thrown immediately.
 *   Silently degrading to an all-undetectable snapshot would hide exactly the
 *   class of packaging bug that shipped @digitaldefiance/node-rs-accelerate@0.1.2
 *   in an unloadable state.
 */
export const CapsErrorCode = {
  /** The native addon could not be loaded. Almost always a packaging bug. */
  NATIVE_LOAD_FAILED: 'NATIVE_LOAD_FAILED',
  /** Running on a platform this package does not support. */
  UNSUPPORTED_PLATFORM: 'UNSUPPORTED_PLATFORM',
  /**
   * This package's own hardcoded tables disagree with observed reality: a
   * REQUIRED capability name has no corresponding key in the enumerated sysctl
   * surface, or the native probe manifest and the TypeScript assembly table
   * are out of sync. Either way it is a defect in this package, not a property
   * of the machine, and must not be papered over with a default.
   */
  MANIFEST_DESYNC: 'MANIFEST_DESYNC',
  /** A caller asked for a capability id that does not exist. */
  UNKNOWN_CAPABILITY: 'UNKNOWN_CAPABILITY',
} as const;

export type CapsErrorCode = (typeof CapsErrorCode)[keyof typeof CapsErrorCode];

export class CapsError extends Error {
  public override readonly name = 'CapsError';

  constructor(
    message: string,
    public readonly code: CapsErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
