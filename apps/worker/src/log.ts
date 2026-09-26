// Structured worker logs. Customer tokens and credentials never reach the log stream (C7).

const SECRET_KEY = /token|authorization|secret|cookie|key/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SECRET_KEY.test(key) ? '[redacted]' : redact(inner)]));
}

export function logEvent(event: Record<string, unknown>): void {
  console.log(JSON.stringify(redact(event)));
}
