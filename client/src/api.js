const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

async function request(path, options) {
  const hasBody = options?.body !== undefined;
  const formBody = typeof FormData !== "undefined" && options?.body instanceof FormData;
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(hasBody && !formBody ? { "Content-Type": "application/json" } : {}),
      ...options?.headers
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message || "Something went wrong. Please try again.");
    error.status = response.status;
    throw error;
  }

  return response.status === 204 ? null : response.json();
}

export const getUpdates = () => request("/api/updates");
export const getUpdate = (id) => request(`/api/updates/${id}`);
export const explainUpdate = (id) =>
  request(`/api/updates/${id}/explain`, { method: "POST" });
export const explainKeyword = (id, keyword) =>
  request(`/api/updates/${id}/keywords/explain`, {
    method: "POST",
    body: JSON.stringify({ keyword })
  });

export const createArticleChat = (url) =>
  request("/api/article-chats", {
    method: "POST",
    body: JSON.stringify({ url })
  });

export const getArticleChats = (limit = 12, offset = 0) =>
  request(`/api/article-chats?limit=${limit}&offset=${offset}`);

export const getArticleChat = (conversationId, writeToken) =>
  request(`/api/article-chats/${conversationId}`, {
    headers: writeToken ? { "X-Chat-Token": writeToken } : {}
  });

export const discoverArticleMedia = (conversationId, writeToken) =>
  request(`/api/article-chats/${conversationId}/media/discover`, {
    method: "POST",
    headers: writeToken ? { "X-Chat-Token": writeToken } : {}
  });

export const askArticleQuestion = (
  conversationId,
  question,
  writeToken,
  selectedMediaId = null
) =>
  request(`/api/article-chats/${conversationId}/messages`, {
    method: "POST",
    headers: writeToken ? { "X-Chat-Token": writeToken } : {},
    body: JSON.stringify({
      question,
      ...(selectedMediaId ? { selectedMediaId } : {})
    })
  });

export async function createPaperWorkspace(file, hash) {
  const form = new FormData();
  form.append("file", file, file.name);
  return request("/api/paper-workspaces", {
    method: "POST",
    headers: { "X-PDF-SHA256": hash },
    body: form
  });
}

export const getActivePaperWorkspace = () =>
  request("/api/paper-workspaces/active");

export const getPaperWorkspace = (workspaceId) =>
  request(`/api/paper-workspaces/${workspaceId}`);

export const updatePaperReaderState = (workspaceId, state) =>
  request(`/api/paper-workspaces/${workspaceId}/reader-state`, {
    method: "PATCH",
    body: JSON.stringify(state)
  });

export const explainPaperSelection = (workspaceId, pageNumber, selectedText) =>
  request(`/api/paper-workspaces/${workspaceId}/explain-selection`, {
    method: "POST",
    body: JSON.stringify({ pageNumber, selectedText })
  });

export const explainPaperFigure = (workspaceId, pageNumber, imageDataUrl) =>
  request(`/api/paper-workspaces/${workspaceId}/explain-figure`, {
    method: "POST",
    body: JSON.stringify({ pageNumber, imageDataUrl })
  });

export const askPaperQuestion = (workspaceId, question, answerMode) =>
  request(`/api/paper-workspaces/${workspaceId}/questions`, {
    method: "POST",
    body: JSON.stringify({ question, answerMode })
  });

export const deletePaperWorkspace = (workspaceId) =>
  request(`/api/paper-workspaces/${workspaceId}`, { method: "DELETE" });
