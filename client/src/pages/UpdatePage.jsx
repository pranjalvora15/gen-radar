import { useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, BookOpen, LoaderCircle, Sparkles } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { explainKeyword, explainUpdate, getUpdate } from "../api";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../components/ui/accordion";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";

const categoryLabels = {
  models: "Models", research: "Research", rag: "RAG", agents: "Agents",
  "langchain-langgraph": "LangChain & LangGraph", multimodal: "Multimodal",
  safety: "Safety", other: "Other"
};

function isCurrentExplanation(value) {
  return Boolean(
    value
    && typeof value.problemSolved === "string"
    && Array.isArray(value.tradeOffs)
    && Array.isArray(value.limitations)
  );
}

export default function UpdatePage() {
  const { id } = useParams();
  const [update, setUpdate] = useState(null);
  const [explanation, setExplanation] = useState(null);
  const [keywordResult, setKeywordResult] = useState(null);
  const [activeKeyword, setActiveKeyword] = useState("");
  const [loading, setLoading] = useState("page");
  const [error, setError] = useState("");

  useEffect(() => {
    getUpdate(id)
      .then((data) => {
        setUpdate(data.update);
        setExplanation(
          isCurrentExplanation(data.update.explanation)
            ? data.update.explanation
            : null
        );
        setLoading("");
      })
      .catch((requestError) => {
        setError(requestError.message);
        setLoading("");
      });
  }, [id]);

  async function handleExplain() {
    setLoading("article");
    setError("");
    try {
      const data = await explainUpdate(id);
      setExplanation(data.explanation);
      setUpdate((current) => ({
        ...current,
        explanation: data.explanation,
        keywords: data.explanation.keywords,
        category: data.explanation.category
      }));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading("");
    }
  }

  async function handleKeyword(keyword) {
    setActiveKeyword(keyword);
    setKeywordResult(null);
    setLoading("keyword");
    setError("");
    try {
      const data = await explainKeyword(id, keyword);
      setKeywordResult(data.explanation);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading("");
    }
  }

  if (loading === "page") {
    return <div className="mx-auto max-w-4xl px-5 py-16 sm:px-8"><Skeleton className="h-[34rem]" /></div>;
  }

  if (!update) {
    return <div className="mx-auto max-w-4xl px-5 py-16 sm:px-8"><Alert>{error || "Update not found."}</Alert></div>;
  }

  const keywords = explanation?.keywords || update.keywords || [];

  return (
    <article className="mx-auto max-w-4xl px-5 pb-12 pt-10 sm:px-8 sm:pt-16">
      <Link to="/" className="inline-flex items-center gap-2 text-sm font-semibold text-ink/60 hover:text-ink">
        <ArrowLeft size={16} /> Back to library
      </Link>

      <header className="mt-10">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <Badge variant="outline">{categoryLabels[update.category]}</Badge>
          <span className="text-xs text-ink/50">{update.sourceName}</span>
        </div>
        <h1 className="max-w-3xl font-serif text-4xl font-medium leading-[1.08] tracking-[-0.025em] sm:text-6xl">
          {update.sourceTitle}
        </h1>
        <p className="mt-6 max-w-2xl whitespace-pre-line text-base leading-7 text-ink/60">{update.displaySummary}</p>
        <a
          href={update.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-moss hover:underline"
        >
          Read original article <ArrowUpRight size={15} />
        </a>
      </header>

      <Separator className="my-10" />
      {error && <Alert className="mb-6">{error}</Alert>}

      {!explanation ? (
        <Card className="overflow-hidden border border-line bg-elevated text-ink">
          <CardContent className="relative p-7 sm:p-10">
            <div className="absolute -right-12 -top-12 size-40 rounded-full bg-acid/20 blur-2xl" />
            <Sparkles className="mb-7 text-acid" size={24} />
            <h2 className="font-serif text-3xl">Turn this article into understanding.</h2>
            <p className="mt-4 max-w-xl text-sm leading-6 text-ink/65">
              Generate a source-grounded explanation of the problem, trade-offs, limitations and concepts worth learning.
            </p>
            <Button
              className="mt-8 bg-acid text-[#0E1512] hover:bg-moss"
              onClick={handleExplain}
              disabled={loading === "article"}
            >
              {loading === "article" ? <><LoaderCircle className="mr-2 animate-spin" size={16} /> Explaining...</> : "Explain this article"}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div>
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="border-0 bg-moss text-[#0E1512]">
              <CardContent>
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#0E1512]/70">In brief</p>
                <p className="mt-5 font-serif text-2xl leading-snug">{explanation.summary}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-moss">Problem it solves</p>
                <p className="mt-5 text-sm leading-7 text-ink/70">{explanation.problemSolved}</p>
              </CardContent>
            </Card>
          </div>

          <section className="py-10">
            <h2 className="font-serif text-3xl">The simple explanation</h2>
            <p className="mt-5 text-base leading-8 text-ink/70">{explanation.simpleExplanation}</p>
            <Accordion type="multiple" className="mt-7">
              <AccordionItem value="points">
                <AccordionTrigger>Key points</AccordionTrigger>
                <AccordionContent>
                  <ul className="space-y-3">
                    {explanation.keyPoints.map((point) => <li key={point}>— {point}</li>)}
                  </ul>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="tradeoffs">
                <AccordionTrigger>Trade-offs</AccordionTrigger>
                <AccordionContent>
                  {explanation.tradeOffs.length ? (
                    <ul className="space-y-3">
                      {explanation.tradeOffs.map((item) => <li key={item}>— {item}</li>)}
                    </ul>
                  ) : "The source did not state a specific trade-off."}
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="limitations">
                <AccordionTrigger>Limitations & uncertainty</AccordionTrigger>
                <AccordionContent>
                  {explanation.limitations.length ? (
                    <ul className="space-y-3">
                      {explanation.limitations.map((item) => <li key={item}>— {item}</li>)}
                    </ul>
                  ) : "The source did not state a specific limitation."}
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </section>

          <section className="rounded-3xl border border-line bg-elevated p-6 sm:p-8">
            <div className="flex items-center gap-3">
              <BookOpen size={20} />
              <h2 className="font-serif text-2xl">Explore the concepts</h2>
            </div>
            <p className="mt-2 text-sm text-ink/55">Choose a term to understand what it means in this update.</p>
            <div className="mt-6 flex flex-wrap gap-2">
              {keywords.map((keyword) => (
                <Button
                  key={keyword}
                  size="sm"
                  variant={activeKeyword === keyword ? "default" : "outline"}
                  onClick={() => handleKeyword(keyword)}
                  disabled={loading === "keyword"}
                >
                  {keyword}
                </Button>
              ))}
            </div>

            {loading === "keyword" && <Skeleton className="mt-6 h-44 bg-ink/10" />}
            {keywordResult && (
              <Card className="mt-6 border-0 bg-cream">
                <CardContent>
                  <Badge>{keywordResult.keyword}</Badge>
                  <h3 className="mt-5 font-serif text-2xl">{keywordResult.simpleDefinition}</h3>
                  <div className="mt-6 grid gap-6 text-sm leading-7 text-ink/70 sm:grid-cols-2">
                    <div>
                      <p className="font-semibold text-ink">In this article</p>
                      <p className="mt-1">{keywordResult.relationToArticle}</p>
                    </div>
                    <div>
                      <p className="font-semibold text-ink">A concrete example</p>
                      <p className="mt-1">{keywordResult.example}</p>
                    </div>
                  </div>
                  {(keywordResult.relatedConcepts.length > 0 || keywordResult.prerequisites.length > 0) && (
                    <div className="mt-6 flex flex-wrap gap-2">
                      {[...keywordResult.prerequisites, ...keywordResult.relatedConcepts].map((item) => (
                        <Badge key={item} variant="outline">{item}</Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </section>
        </div>
      )}
    </article>
  );
}
