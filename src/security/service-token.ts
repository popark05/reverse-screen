import { timingSafeEqual } from "node:crypto";

export function verifyServiceBearerToken(
  authorization: string | string[] | undefined,
  expectedToken: string | undefined
): boolean {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ") ||
      !expectedToken || Buffer.byteLength(expectedToken) < 32) return false;
  const supplied = Buffer.from(authorization.slice(7), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
