import { createHash } from "node:crypto";

export function normalizeQuestion(value) {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[“”"'`?!,:;()[\]{}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function questionHash(value) {
  return createHash("sha256")
    .update(normalizeQuestion(value))
    .digest("hex");
}
