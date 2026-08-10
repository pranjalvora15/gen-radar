import {
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

export function createConversationToken() {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    hash: hashConversationToken(token)
  };
}

export function hashConversationToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function conversationTokenMatches(token, expectedHash) {
  if (!token || !expectedHash) return false;

  const supplied = Buffer.from(hashConversationToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
