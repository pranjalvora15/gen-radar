import { ArrowRight, MessageCircle } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";

function relativeTime(value) {
  const seconds = Math.max(1, Math.round((Date.now() - new Date(value)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function PublicChatCard({ chat }) {
  return (
    <Card className="flex h-full flex-col p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink/45">
        <Badge variant="outline">Public chat</Badge>
        <span>{chat.articleSource}</span>
        <span aria-hidden="true">·</span>
        <span>{relativeTime(chat.updatedAt)}</span>
      </div>

      <Link
        to={`/chat/${chat.id}`}
        className="mt-5 font-serif text-2xl leading-tight transition hover:text-acid"
      >
        {chat.firstQuestion}
      </Link>
      <p className="mt-3 line-clamp-2 text-xs font-semibold uppercase tracking-[0.12em] text-moss">
        {chat.articleTitle}
      </p>
      <p className="mt-4 line-clamp-3 text-sm leading-6 text-ink/55">
        {chat.answerPreview}
      </p>

      <div className="mt-auto flex items-center justify-between gap-4 pt-6">
        <span className="inline-flex items-center gap-1.5 text-xs text-ink/40">
          <MessageCircle size={14} /> {chat.questionCount} {chat.questionCount === 1 ? "question" : "questions"}
        </span>
        <Link
          to={`/chat/${chat.id}`}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-moss hover:underline"
        >
          Read chat <ArrowRight size={14} />
        </Link>
      </div>
    </Card>
  );
}
