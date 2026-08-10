export function vectorLiteral(values) {
  if (
    !Array.isArray(values)
    || values.length === 0
    || values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Embedding must be a non-empty array of finite numbers");
  }
  return `[${values.join(",")}]`;
}

export async function retrieveArticleChunks(
  database,
  articleId,
  embedding,
  limit = Number(process.env.RETRIEVAL_LIMIT || 5)
) {
  const result = await database.query(
    `SELECT id, chunk_index, content,
            1 - (embedding <=> $2::vector) AS similarity
       FROM article_chunks
      WHERE article_id = $1
      ORDER BY embedding <=> $2::vector
      LIMIT $3`,
    [articleId, vectorLiteral(embedding), limit]
  );

  return result.rows.map((row) => ({
    id: `article-${row.chunk_index}`,
    chunkId: Number(row.id),
    chunkIndex: row.chunk_index,
    excerpt: row.content,
    similarity: Number(row.similarity),
    sourceType: "article"
  }));
}
