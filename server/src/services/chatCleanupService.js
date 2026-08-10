export async function deleteExpiredChats(database) {
  const result = await database.query(
    `DELETE FROM conversations
      WHERE expires_at <= NOW()
      RETURNING id`
  );
  return result.rowCount;
}
