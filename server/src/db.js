import pg from "pg";

const { Pool } = pg;

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000
  });
}

export function mapUpdate(row) {
  return {
    id: Number(row.id),
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    sourceName: row.source_name,
    sourceContent: row.source_content,
    sourceSnippet: row.source_snippet,
    displaySummary: row.display_summary
      || row.explanation?.summary
      || row.source_snippet,
    contentHash: row.content_hash || null,
    contentLength: Number(row.content_length || row.source_content?.length || 0),
    contentTruncated: Boolean(row.content_truncated),
    extractedAt: row.extracted_at || null,
    extractionMethod: row.extraction_method || null,
    sourcePublishedAt: row.source_published_at,
    discoveredAt: row.discovered_at,
    category: row.category,
    explanation: row.explanation,
    explanationStatus: row.explanation_status || (row.explanation ? "ready" : "pending"),
    keywords: row.keywords || []
  };
}

export function mapChatArticle(row) {
  return {
    id: Number(row.article_id ?? row.id),
    canonicalUrl: row.canonical_url,
    title: row.title,
    sourceName: row.source_name,
    content: row.content,
    contentHash: row.content_hash,
    processingMode: row.processing_mode,
    suggestedQuestions: row.suggested_questions || [],
    mediaStatus: row.media_status || "pending",
    mediaExtractionVersion: Number(row.media_extraction_version || 1),
    createdAt: row.article_created_at ?? row.created_at
  };
}

export function mapChatMessage(row) {
  return {
    id: Number(row.id),
    role: row.role,
    content: row.content,
    answerMode: row.answer_mode,
    citations: row.citations || [],
    selectedMediaId: row.selected_media_id
      ? Number(row.selected_media_id)
      : null,
    replyToMessageId: row.reply_to_message_id
      ? Number(row.reply_to_message_id)
      : null,
    createdAt: row.created_at
  };
}

export function mapConversation(row, messages = [], media = []) {
  return {
    id: row.conversation_id ?? row.id,
    canWrite: Boolean(row.can_write),
    summary: row.summary || "",
    status: row.status || "active",
    closedReason: row.closed_reason || null,
    closedAt: row.closed_at || null,
    expiresAt: row.expires_at,
    createdAt: row.conversation_created_at ?? row.created_at,
    updatedAt: row.conversation_updated_at ?? row.updated_at,
    article: mapChatArticle(row),
    messages,
    media
  };
}
