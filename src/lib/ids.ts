import { randomUUID } from "node:crypto";

/** Generate a unique row id. */
export function newId(): string {
  return randomUUID();
}
