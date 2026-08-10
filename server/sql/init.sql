CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS updates (
  id BIGSERIAL PRIMARY KEY,
  source_url TEXT NOT NULL UNIQUE,
  source_title TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_content TEXT NOT NULL,
  source_snippet TEXT NOT NULL DEFAULT '',
  display_summary TEXT NOT NULL DEFAULT '',
  content_hash TEXT,
  content_length INTEGER,
  content_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  extracted_at TIMESTAMPTZ,
  extraction_method TEXT,
  source_published_at TIMESTAMPTZ,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  category TEXT NOT NULL CHECK (category IN (
    'models', 'research', 'rag', 'agents',
    'langchain-langgraph', 'multimodal', 'safety', 'other'
  )),
  explanation JSONB,
  explanation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (explanation_status IN ('pending', 'generating', 'ready', 'failed')),
  explanation_started_at TIMESTAMPTZ,
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE updates ADD COLUMN IF NOT EXISTS display_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE updates ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE updates ADD COLUMN IF NOT EXISTS content_length INTEGER;
ALTER TABLE updates ADD COLUMN IF NOT EXISTS content_truncated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE updates ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMPTZ;
ALTER TABLE updates ADD COLUMN IF NOT EXISTS extraction_method TEXT;
ALTER TABLE updates ADD COLUMN IF NOT EXISTS explanation_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE updates ADD COLUMN IF NOT EXISTS explanation_started_at TIMESTAMPTZ;

ALTER TABLE updates DROP CONSTRAINT IF EXISTS updates_explanation_status_check;
ALTER TABLE updates ADD CONSTRAINT updates_explanation_status_check
  CHECK (explanation_status IN ('pending', 'generating', 'ready', 'failed'));

UPDATE updates
   SET display_summary = COALESCE(NULLIF(explanation->>'summary', ''), source_snippet)
 WHERE display_summary = '';

UPDATE updates
   SET explanation_status = CASE
     WHEN explanation IS NULL THEN 'pending'
     ELSE 'ready'
   END
 WHERE explanation_status = 'pending';

CREATE INDEX IF NOT EXISTS updates_discovered_at_idx
  ON updates (discovered_at DESC);

CREATE INDEX IF NOT EXISTS updates_category_idx
  ON updates (category);

CREATE TABLE IF NOT EXISTS discovery_cache (
  cache_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feed_refresh_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'refreshing', 'failed')),
  last_started_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO feed_refresh_state (id, last_completed_at)
SELECT 1, MAX(discovered_at) FROM updates
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS keyword_explanations (
  id BIGSERIAL PRIMARY KEY,
  update_id BIGINT NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  keyword_key TEXT NOT NULL,
  explanation JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (update_id, keyword_key)
);

CREATE TABLE IF NOT EXISTS chat_articles (
  id BIGSERIAL PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  source_name TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  processing_mode TEXT NOT NULL CHECK (processing_mode IN ('direct', 'vector')),
  suggested_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  media_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (media_status IN ('pending', 'processing', 'ready', 'partial', 'failed')),
  media_processing_started_at TIMESTAMPTZ,
  media_extraction_version INTEGER NOT NULL DEFAULT 3,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE chat_articles
  ADD COLUMN IF NOT EXISTS suggested_questions JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE chat_articles
  ADD COLUMN IF NOT EXISTS media_status TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE chat_articles
  ADD COLUMN IF NOT EXISTS media_processing_started_at TIMESTAMPTZ;

ALTER TABLE chat_articles
  DROP CONSTRAINT IF EXISTS chat_articles_media_status_check;

ALTER TABLE chat_articles
  ADD CONSTRAINT chat_articles_media_status_check
  CHECK (media_status IN ('pending', 'processing', 'ready', 'partial', 'failed'));

ALTER TABLE chat_articles
  ADD COLUMN IF NOT EXISTS media_extraction_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE chat_articles
  ALTER COLUMN media_extraction_version SET DEFAULT 4;

ALTER TABLE chat_articles
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS chat_articles_content_hash_idx
  ON chat_articles (content_hash);

CREATE TABLE IF NOT EXISTS article_chunks (
  id BIGSERIAL PRIMARY KEY,
  article_id BIGINT NOT NULL REFERENCES chat_articles(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(768) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (article_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS article_media (
  id BIGSERIAL PRIMARY KEY,
  article_id BIGINT NOT NULL REFERENCES chat_articles(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
  source_url TEXT NOT NULL,
  source_order INTEGER,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'pending', 'analyzed', 'ignored', 'failed')),
  analysis_text TEXT,
  analysis JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (article_id, source_url)
);

ALTER TABLE article_media
  ADD COLUMN IF NOT EXISTS source_order INTEGER;

WITH ranked_media AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY article_id, media_type
           ORDER BY id
         )::int AS source_order
    FROM article_media
)
UPDATE article_media
   SET source_order = ranked_media.source_order
  FROM ranked_media
 WHERE article_media.id = ranked_media.id
   AND article_media.source_order IS NULL;

ALTER TABLE article_media
  DROP CONSTRAINT IF EXISTS article_media_status_check;

ALTER TABLE article_media
  ADD CONSTRAINT article_media_status_check
  CHECK (status IN ('available', 'pending', 'analyzed', 'ignored', 'failed'));

ALTER TABLE article_media
  ALTER COLUMN status SET DEFAULT 'available';

CREATE INDEX IF NOT EXISTS article_media_article_id_idx
  ON article_media (article_id, media_type, status);

CREATE INDEX IF NOT EXISTS article_chunks_embedding_hnsw_idx
  ON article_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY,
  article_id BIGINT NOT NULL REFERENCES chat_articles(id) ON DELETE CASCADE,
  write_token_hash TEXT,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'closed_scope')),
  closed_at TIMESTAMPTZ,
  closed_reason TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '3 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS closed_reason TEXT;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
    NOT NULL DEFAULT (NOW() + INTERVAL '3 days');

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS write_token_hash TEXT;

CREATE INDEX IF NOT EXISTS conversations_article_id_idx
  ON conversations (article_id);

CREATE INDEX IF NOT EXISTS conversations_expires_at_idx
  ON conversations (expires_at);

CREATE INDEX IF NOT EXISTS conversations_public_list_idx
  ON conversations (status, updated_at DESC)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  normalized_question TEXT,
  question_hash TEXT,
  question_embedding VECTOR(768),
  selected_media_id BIGINT REFERENCES article_media(id) ON DELETE SET NULL,
  reply_to_message_id BIGINT REFERENCES chat_messages(id) ON DELETE SET NULL,
  answer_mode TEXT CHECK (
    answer_mode IS NULL OR answer_mode IN (
      'article', 'general', 'media', 'web_search', 'combined',
      'insufficient', 'guardrail'
    )
  ),
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS normalized_question TEXT;

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS question_hash TEXT;

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS question_embedding VECTOR(768);

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS selected_media_id BIGINT
    REFERENCES article_media(id) ON DELETE SET NULL;

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id BIGINT
    REFERENCES chat_messages(id) ON DELETE SET NULL;

ALTER TABLE chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_answer_mode_check;

ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_answer_mode_check
  CHECK (
    answer_mode IS NULL OR answer_mode IN (
      'article', 'general', 'media', 'web_search', 'combined',
      'insufficient', 'guardrail'
    )
  );

CREATE INDEX IF NOT EXISTS chat_messages_conversation_id_idx
  ON chat_messages (conversation_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_question_hash_unique_idx
  ON chat_messages (conversation_id, question_hash)
  WHERE role = 'user' AND question_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_messages_question_hash_idx
  ON chat_messages (question_hash)
  WHERE role = 'user' AND question_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_messages_selected_media_id_idx
  ON chat_messages (selected_media_id)
  WHERE selected_media_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_messages_question_embedding_hnsw_idx
  ON chat_messages USING hnsw (question_embedding vector_cosine_ops)
  WHERE role = 'user' AND question_embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS paper_documents (
  id BIGSERIAL PRIMARY KEY,
  file_hash TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  page_count INTEGER,
  file_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'ready', 'rejected', 'failed')),
  is_ai_related BOOLEAN,
  relevance_confidence DOUBLE PRECISION,
  relevance_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS paper_documents_status_idx
  ON paper_documents (status, updated_at);

CREATE TABLE IF NOT EXISTS paper_pages (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES paper_documents(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL CHECK (page_number > 0),
  page_text TEXT NOT NULL,
  character_count INTEGER NOT NULL CHECK (character_count >= 0),
  UNIQUE (document_id, page_number)
);

CREATE TABLE IF NOT EXISTS paper_chunks (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES paper_documents(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL CHECK (page_number > 0),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content TEXT NOT NULL,
  embedding VECTOR(768) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, page_number, chunk_index)
);

CREATE INDEX IF NOT EXISTS paper_chunks_document_page_idx
  ON paper_chunks (document_id, page_number, chunk_index);

CREATE INDEX IF NOT EXISTS paper_chunks_embedding_hnsw_idx
  ON paper_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS paper_workspaces (
  id UUID PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES paper_documents(id) ON DELETE CASCADE,
  owner_token_hash TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  current_page INTEGER NOT NULL DEFAULT 1 CHECK (current_page > 0),
  zoom DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (zoom >= 0.5 AND zoom <= 3),
  ai_action_count INTEGER NOT NULL DEFAULT 0 CHECK (ai_action_count >= 0),
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'ready', 'rejected', 'failed')),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS paper_workspaces_owner_idx
  ON paper_workspaces (owner_token_hash, expires_at DESC);

CREATE INDEX IF NOT EXISTS paper_workspaces_expiry_idx
  ON paper_workspaces (expires_at);

CREATE TABLE IF NOT EXISTS paper_upload_attempts (
  id BIGSERIAL PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS paper_upload_attempts_ip_time_idx
  ON paper_upload_attempts (ip_hash, created_at DESC);
