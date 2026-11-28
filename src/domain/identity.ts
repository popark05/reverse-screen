import { createHash } from "node:crypto";

/**
 * Deterministic UUID (RFC 9562 version 8 layout) derived from SHA-256 of the given parts.
 * The same logical screen, state or transition observed again maps to the same ID,
 * so revisits and repeated paths collapse into one graph node/edge.
 */
export function deterministicUuid(namespace: string, ...parts: string[]): string {
  const bytes = createHash("sha256").update([namespace, ...parts].join("\u001f")).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
