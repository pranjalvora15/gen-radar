import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FileText } from "lucide-react";
import { getUpdates } from "../api";
import ArticleUrlForm from "../components/ArticleUrlForm";
import PublicChatsPreview from "../components/PublicChatsPreview";
import UpdateCard from "../components/UpdateCard";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";

const categories = [
  ["all", "All topics"],
  ["models", "Models"],
  ["research", "Research"],
  ["rag", "RAG"],
  ["agents", "Agents"],
  ["langchain-langgraph", "LangChain & LangGraph"],
  ["multimodal", "Multimodal"],
  ["safety", "Safety"],
  ["other", "Other"]
];

const DISPLAY_LIMIT = 10;

export default function HomePage() {
  const [updates, setUpdates] = useState([]);
  const [activeCategory, setActiveCategory] = useState("all");
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let timer;

    function loadFeed() {
      getUpdates()
        .then((data) => {
          if (!active) return;
          setUpdates(data.updates.slice(0, DISPLAY_LIMIT));
          setState("ready");
          if (data.feed?.refreshing) {
            timer = setTimeout(loadFeed, 10_000);
          }
        })
        .catch((requestError) => {
          if (!active) return;
          setError(requestError.message);
          setState("error");
        });
    }

    loadFeed();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  const visibleUpdates = useMemo(
    () =>
      activeCategory === "all"
        ? updates
        : updates.filter((update) => update.category === activeCategory),
    [updates, activeCategory]
  );

  return (
    <>
      <section className="mx-auto max-w-6xl px-5 pb-12 pt-16 sm:px-8 sm:pb-16 sm:pt-24">
        <div className="max-w-3xl">
          <p className="mb-5 text-xs font-bold uppercase tracking-[0.22em] text-moss">A practical GenAI reading room</p>
          <h1 className="font-serif text-5xl font-medium leading-[0.98] tracking-[-0.04em] sm:text-7xl">
            Understand the systems.
            <span className="block text-moss">Not just the headlines.</span>
          </h1>
          <p className="mt-7 max-w-xl text-base leading-7 text-ink/60 sm:text-lg">
            Curated engineering blogs and tutorials about RAG, knowledge graphs, agents, models and the ideas behind them.
          </p>
        </div>
        <ArticleUrlForm />
        <div className="mt-5 flex items-center gap-4 rounded-2xl border border-line bg-cream p-5">
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-elevated text-acid">
            <FileText size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Read an AI white paper</p>
            <p className="mt-1 text-sm text-ink/55">Upload one private PDF, select difficult passages, and ask page-grounded questions.</p>
          </div>
          <Link
            className="inline-flex h-11 shrink-0 items-center justify-center rounded-full bg-acid px-5 text-sm font-semibold text-[#0E1512] transition hover:bg-moss"
            to="/papers"
          >
            Open reader
          </Link>
        </div>
        <div className="mt-12 flex flex-wrap gap-2" aria-label="Filter updates by category">
          {categories.map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={activeCategory === value ? "default" : "outline"}
              onClick={() => setActiveCategory(value)}
              aria-pressed={activeCategory === value}
            >
              {label}
            </Button>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-[#111A16]">
        <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
          <div className="mb-8 flex items-baseline justify-between">
            <h2 className="text-sm font-bold uppercase tracking-[0.18em]">Technical reading</h2>
            {state === "ready" && <span className="text-xs text-ink/50">{visibleUpdates.length} articles</span>}
          </div>

          {state === "error" && <Alert>{error}</Alert>}

          {state === "loading" && (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3, 4, 5, 6].map((item) => (
                <Skeleton key={item} className="h-72" />
              ))}
            </div>
          )}

          {state === "ready" && visibleUpdates.length > 0 && (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {visibleUpdates.map((update) => <UpdateCard key={update.id} update={update} />)}
            </div>
          )}

          {state === "ready" && visibleUpdates.length === 0 && (
            <div className="rounded-2xl border border-dashed border-ink/20 px-6 py-16 text-center">
              <p className="font-serif text-2xl">No articles here yet.</p>
              <p className="mt-2 text-sm text-ink/55">Try another topic or refresh the technical library.</p>
            </div>
          )}
        </div>
      </section>

      <PublicChatsPreview />
    </>
  );
}
