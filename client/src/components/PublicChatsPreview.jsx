import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { getArticleChats } from "../api";
import PublicChatCard from "./PublicChatCard";
import { Skeleton } from "./ui/skeleton";

export default function PublicChatsPreview() {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getArticleChats(3, 0)
      .then((data) => setChats(data.chats))
      .catch(() => setChats([]))
      .finally(() => setLoading(false));
  }, []);

  if (!loading && chats.length === 0) return null;

  return (
    <section className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
      <div className="mb-8 flex items-end justify-between gap-5">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-moss">Learn together</p>
          <h2 className="mt-3 font-serif text-3xl sm:text-4xl">Recent community questions</h2>
        </div>
        <Link to="/chats" className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-moss hover:underline">
          View all <ArrowRight size={15} />
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {loading
          ? [1, 2, 3].map((item) => <Skeleton key={item} className="h-72" />)
          : chats.map((chat) => <PublicChatCard key={chat.id} chat={chat} />)}
      </div>
    </section>
  );
}
