// A refusal (D1 §11.5): {code, reason, what_to_do, subject}, with the HTTP
// status it is answered with. Startup refusals use the same shape on stderr.

export interface RefusalBody {
  code: string;
  reason: string;
  what_to_do: string;
  subject: unknown;
}

export class Refusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: string;
  readonly whatToDo: string;
  readonly subject: unknown;

  constructor(status: number, code: string, reason: string, whatToDo: string, subject: unknown = {}) {
    super(`${code}: ${reason}`);
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.whatToDo = whatToDo;
    this.subject = subject;
  }

  body(): RefusalBody {
    return { code: this.code, reason: this.reason, what_to_do: this.whatToDo, subject: this.subject };
  }

  // Refusals cross the store worker boundary as plain data.
  toWire(): WireRefusal {
    return { status: this.status, ...this.body() };
  }

  static fromWire(w: WireRefusal): Refusal {
    return new Refusal(w.status, w.code, w.reason, w.what_to_do, w.subject);
  }
}

export interface WireRefusal extends RefusalBody {
  status: number;
}

export function storeError(err: unknown): Refusal {
  const detail = err instanceof Error ? err.message : String(err);
  return new Refusal(
    500,
    'store_error',
    `The store transaction failed and was rolled back: ${detail}`,
    'Nothing was changed. Retry the request; if it fails again, inspect the engine log and the store.',
  );
}
