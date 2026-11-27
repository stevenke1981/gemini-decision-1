/** Stable decision error codes exposed by the SDK and the transports. */
export class DecisionError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
  }
}

/**
 * An input the caller sent is wrong: a transport answers it as the caller's mistake (HTTP 400,
 * `INVALID_INPUT`). It is a TypeError, as every input check throws; a plain TypeError that is
 * not an InputError is a fault of the program, not of the input.
 */
export class InputError extends TypeError {
  constructor(message, options) {
    super(message, options);
    this.name = 'InputError';
    this.code = 'INVALID_INPUT';
  }
}

/** `err` as an InputError: itself, or a TypeError's message with the original as its cause. */
export function asInputError(err) {
  if (err instanceof InputError || !(err instanceof TypeError)) return err;
  return new InputError(err.message, { cause: err });
}

export function errorCode(error, fallback = 'INTERNAL_ERROR') {
  return error instanceof DecisionError || error instanceof InputError ? error.code : fallback;
}
