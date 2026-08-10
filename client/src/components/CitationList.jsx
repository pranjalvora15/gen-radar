import { ArrowUpRight } from "lucide-react";
import { Badge } from "./ui/badge";

export default function CitationList({ citations = [] }) {
  if (citations.length === 0) return null;

  return (
    <div className="mt-5 border-t border-line/70 pt-4">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-ink/45">Sources</p>
      <div className="mt-3 space-y-3">
        {citations.map((citation, index) => (
          <a
            key={`${citation.url}-${index}`}
            href={citation.url}
            target="_blank"
            rel="noreferrer"
            className="block rounded-xl border border-line/70 p-3 transition hover:border-moss/70"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant="outline">
                  {{
                    article: "Article",
                    image: "Image",
                    video: "Video",
                    web: "Web"
                  }[citation.sourceType] || "Source"}
                  {citation.timestamp ? ` · ${citation.timestamp}` : ""}
                </Badge>
                <span className="truncate text-xs font-semibold">{citation.title}</span>
              </div>
              <ArrowUpRight className="shrink-0 text-ink/45" size={14} />
            </div>
            <p className="mt-2 line-clamp-3 text-xs leading-5 text-ink/50">
              {citation.excerpt}
            </p>
          </a>
        ))}
      </div>
    </div>
  );
}
