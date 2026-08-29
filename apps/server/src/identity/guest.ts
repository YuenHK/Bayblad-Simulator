import { randomBytes } from "node:crypto";

export function createGuestDisplayName(): string {
  return `訪客-${randomBytes(2).toString("hex").toUpperCase()}`;
}
