/**
 * A fresh idempotency key for one user action. The server requires 16-200
 * characters; a retry of the same action reuses the key, a new action gets a
 * new one.
 */
export function newActionKey(action: "duplicate" | "edit" | "rename" | "visibility"): string {
  return `web-${action}-${crypto.randomUUID()}`;
}
