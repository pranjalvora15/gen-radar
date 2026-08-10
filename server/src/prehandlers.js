import { mapChatMessage, mapConversation, mapUpdate } from "./db.js";
import {
  conversationTokenMatches
} from "./services/conversationTokenService.js";
import {
  findOwnedWorkspace,
  mapPaperWorkspace,
  PAPER_COOKIE
} from "./services/paperWorkspaceService.js";

function mediaPreviewUrl(sourceUrl) {
  return `https://wsrv.nl/?url=${encodeURIComponent(sourceUrl)}`;
}

export async function loadUpdate(request, reply) {
  const result = await request.server.db.query(
    `SELECT id, source_url, source_title, source_name, source_content,
            source_snippet, display_summary, content_hash, content_length,
            content_truncated, extracted_at, extraction_method,
            source_published_at, discovered_at, category,
            explanation, explanation_status, keywords
       FROM updates
      WHERE id = $1`,
    [request.params.id]
  );

  if (result.rowCount === 0) {
    return reply.code(404).send({ message: "Update not found" });
  }

  request.update = mapUpdate(result.rows[0]);
}

export async function loadConversation(request, reply) {
  const conversationResult = await request.server.db.query(
    `SELECT c.id AS conversation_id, c.summary,
            c.status, c.closed_at, c.closed_reason, c.expires_at,
            c.write_token_hash,
            c.created_at AS conversation_created_at,
            c.updated_at AS conversation_updated_at,
            a.id AS article_id, a.canonical_url, a.title, a.source_name,
            a.content, a.content_hash, a.processing_mode,
            a.suggested_questions, a.media_status,
            a.media_extraction_version,
            a.created_at AS article_created_at
       FROM conversations c
       JOIN chat_articles a ON a.id = c.article_id
      WHERE c.id = $1`,
    [request.params.conversationId]
  );

  if (conversationResult.rowCount === 0) {
    return reply.code(404).send({ message: "Conversation not found" });
  }
  if (new Date(conversationResult.rows[0].expires_at) <= new Date()) {
    return reply.code(410).send({ message: "This conversation has expired" });
  }

  const messagesResult = await request.server.db.query(
    `SELECT id, role, content, answer_mode, citations, selected_media_id,
            reply_to_message_id, created_at
       FROM chat_messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC, id ASC`,
    [request.params.conversationId]
  );

  const mediaResult = await request.server.db.query(
    `SELECT id, media_type, source_url, source_order, status, analysis, analysis_text
       FROM article_media
      WHERE article_id = $1
        AND status IN ('available', 'pending', 'analyzed')
      ORDER BY COALESCE(source_order, id), id`,
    [conversationResult.rows[0].article_id]
  );

  request.conversation = mapConversation(
    {
      ...conversationResult.rows[0],
      can_write: conversationTokenMatches(
        request.headers["x-chat-token"],
        conversationResult.rows[0].write_token_hash
      )
    },
    messagesResult.rows.map(mapChatMessage),
    mediaResult.rows.map((row) => ({
      id: Number(row.id),
      mediaType: row.media_type,
      sourceUrl: row.source_url,
      previewUrl: mediaPreviewUrl(row.source_url),
      sourceOrder: Number(row.source_order || row.id),
      status: row.status,
      analysis: row.analysis,
      analysisText: row.analysis_text
    }))
  );
}

export async function requireConversationWriteToken(request, reply) {
  if (!request.conversation?.canWrite) {
    return reply.code(403).send({
      message: "This public conversation is read-only. Start a new chat to ask questions."
    });
  }
}

export async function loadPaperWorkspace(request, reply) {
  const row = await findOwnedWorkspace(
    request.server.db,
    request.cookies?.[PAPER_COOKIE],
    request.params.workspaceId
  );
  if (!row) {
    return reply.code(404).send({ message: "Paper workspace not found" });
  }
  if (new Date(row.expires_at) <= new Date()) {
    reply.clearCookie(PAPER_COOKIE, { path: "/" });
    return reply.code(410).send({ message: "This paper workspace has expired" });
  }
  request.paperWorkspaceRow = row;
  request.paperWorkspace = mapPaperWorkspace(row);
}
