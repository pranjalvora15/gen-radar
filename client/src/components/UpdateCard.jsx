import { ArrowRight, BookOpen, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "./ui/badge";
import { Card, CardContent } from "./ui/card";

const categoryLabels = {
  models: "Models",
  research: "Research",
  rag: "RAG",
  agents: "Agents",
  "langchain-langgraph": "LangChain & LangGraph",
  multimodal: "Multimodal",
  safety: "Safety",
  other: "Other"
};

export default function UpdateCard({ update }) {
  return (
    <Card className="group h-full overflow-hidden transition duration-300 hover:-translate-y-1 hover:border-ink/30 hover:shadow-card">
      <CardContent className="flex h-full flex-col p-5 sm:p-6">
        <div className="mb-7 flex items-center justify-between gap-3">
          <Badge variant="outline">{categoryLabels[update.category]}</Badge>
          {update.explanation && (
            <span className="flex items-center gap-1 text-[11px] font-semibold text-moss">
              <Sparkles size={12} /> Explained
            </span>
          )}
        </div>
        <Link to={`/updates/${update.id}`} className="focus-visible:outline-none">
          <h2 className="font-serif text-[1.35rem] font-medium leading-snug tracking-tight decoration-1 underline-offset-4 group-hover:underline">
            {update.sourceTitle}
          </h2>
        </Link>
        <p className="mt-4 line-clamp-3 text-sm leading-6 text-ink/60">{update.displaySummary}</p>
        <div className="mt-auto flex items-end justify-between gap-4 pt-8 text-xs text-ink/50">
          <div>
            <p className="font-semibold text-ink/75">{update.sourceName}</p>
            <p className="mt-1 flex items-center gap-1.5"><BookOpen size={12} /> Technical article</p>
          </div>
          <ArrowRight className="size-4 transition group-hover:translate-x-1" />
        </div>
      </CardContent>
    </Card>
  );
}
