function storageKey(conversationId) {
  return `gen-radar-chat-token:${conversationId}`;
}

export function saveChatToken(conversationId, token, expiresAt) {
  localStorage.setItem(
    storageKey(conversationId),
    JSON.stringify({ token, expiresAt })
  );
}

export function getChatToken(conversationId) {
  const key = storageKey(conversationId);
  const stored = localStorage.getItem(key);
  if (!stored) return null;

  try {
    const value = JSON.parse(stored);
    if (!value.token || new Date(value.expiresAt) <= new Date()) {
      localStorage.removeItem(key);
      return null;
    }
    return value.token;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

export function removeChatToken(conversationId) {
  localStorage.removeItem(storageKey(conversationId));
}
