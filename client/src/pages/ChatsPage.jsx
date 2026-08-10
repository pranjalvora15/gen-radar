import { useEffect, useState } from "react";
import { getArticleChats } from "../api";
import PublicChatCard from "../components/PublicChatCard";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";

const PAGE_SIZE = 12;

export default function ChatsPage() {
  const [chats, setChats] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadChats(offset) {
    setLoading(true);
    setError("");
    try {
      const data = await getArticleChats(PAGE_SIZE, offset);
      setChats((current) => offset === 0 ? data.chats : [...current, ...data.chats]);
      setHasMore(data.hasMore);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadChats(0);
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
      <div className="max-w-2xl">
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-moss">Community learning feed</p>
        <h1 className="mt-4 font-serif text-4xl leading-tight sm:text-6xl">Learn from questions others asked.</h1>
        <p className="mt-5 text-base leading-7 text-ink/55">
          Read source-aware AI conversations from the last three days. Public chats are read-only; start a new chat to explore an article yourself.
        </p>
      </div>

      {error && <Alert className="mt-8">{error}</Alert>}

      <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {chats.map((chat) => <PublicChatCard key={chat.id} chat={chat} />)}
        {loading && [1, 2, 3].map((item) => <Skeleton key={`loading-${item}`} className="h-72" />)}
      </div>

      {!loading && chats.length === 0 && !error && (
        <div className="mt-10 rounded-3xl border border-dashed border-ink/20 px-6 py-16 text-center">
          <p className="font-serif text-2xl">No public conversations yet.</p>
          <p className="mt-2 text-sm text-ink/50">Start an article chat and ask the first question.</p>
        </div>
      )}

      {hasMore && !loading && (
        <div className="mt-10 text-center">
          <Button variant="outline" onClick={() => loadChats(chats.length)}>Load more chats</Button>
        </div>
      )}
    </div>
  );
}
