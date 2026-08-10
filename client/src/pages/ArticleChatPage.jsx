import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  CopyPlus,
  LoaderCircle,
  Send,
  Sparkles
} from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  askArticleQuestion,
  createArticleChat,
  discoverArticleMedia,
  getArticleChat,
} from "../api";
import {
  getChatToken,
  removeChatToken,
  saveChatToken
} from "../chatTokens";
import ArticleImagePanel from "../components/ArticleImagePanel";
import ChatMessage from "../components/ChatMessage";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";

export default function ArticleChatPage() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const [conversation, setConversation] = useState(null);
  const [writeToken, setWriteToken] = useState(null);
  const [messages, setMessages] = useState([]);
  const [selectedMediaId, setSelectedMediaId] = useState(null);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState("page");
  const [error, setError] = useState("");
  const [mediaError, setMediaError] = useState("");
  const bottomRef = useRef(null);
  const mediaDiscoveryKeyRef = useRef("");

  useEffect(() => {
    const token = getChatToken(conversationId);
    setWriteToken(token);
    setSelectedMediaId(null);
    setMediaError("");
    mediaDiscoveryKeyRef.current = "";
    setLoading("page");
    setError("");
    getArticleChat(conversationId, token)
      .then((data) => {
        setConversation(data.conversation);
        setMessages(data.conversation.messages);
        setLoading("");
      })
      .catch((requestError) => {
        if (requestError.status === 410) {
          removeChatToken(conversationId);
        }
        setError(requestError.message);
        setLoading("");
      });
  }, [conversationId]);

  useEffect(() => {
    const status = conversation?.article?.mediaStatus;
    if (
      !conversation?.canWrite
      || !writeToken
      || !["pending", "processing", "failed"].includes(status)
    ) return;
    if (status === "failed" && mediaDiscoveryKeyRef.current) return;

    const discoveryKey = `${conversationId}:${status}`;
    if (mediaDiscoveryKeyRef.current === discoveryKey) return;
    mediaDiscoveryKeyRef.current = discoveryKey;
    setMediaError("");
    discoverArticleMedia(conversationId, writeToken)
      .then(() => getArticleChat(conversationId, writeToken))
      .then((data) => setConversation(data.conversation))
      .catch((requestError) => setMediaError(requestError.message));
  }, [
    conversationId,
    conversation?.article?.mediaStatus,
    conversation?.canWrite,
    writeToken
  ]);

  useEffect(() => {
    const status = conversation?.article?.mediaStatus;
    if (!["pending", "processing"].includes(status)) return undefined;

    let active = true;
    const timer = setInterval(() => {
      getArticleChat(conversationId, writeToken)
        .then((data) => {
          if (active) setConversation(data.conversation);
        })
        .catch(() => {});
    }, 2_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [conversationId, conversation?.article?.mediaStatus, writeToken]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function handleSubmit(event) {
    event.preventDefault();
    const value = question.trim();
    if (!value || loading === "answer") return;

    const temporaryMessage = {
      id: `temporary-${Date.now()}`,
      role: "user",
      content: value,
      selectedMediaId,
      citations: [],
      createdAt: new Date().toISOString()
    };
    setMessages((current) => [...current, temporaryMessage]);
    setQuestion("");
    setError("");
    setLoading("answer");

    try {
      const data = await askArticleQuestion(
        conversationId,
        value,
        writeToken,
        selectedMediaId
      );
      setMessages((current) => [...current, data.message]);
      setSelectedMediaId(null);
      setConversation((current) => ({
        ...current,
        status: data.conversationStatus
      }));
    } catch (requestError) {
      if (requestError.status === 403) {
        removeChatToken(conversationId);
        setWriteToken(null);
        setConversation((current) => ({ ...current, canWrite: false }));
      }
      setError(requestError.message);
    } finally {
      setLoading("");
    }
  }

  async function handleStartNewChat() {
    if (loading) return;
    setLoading("fork");
    setError("");
    try {
      const data = await createArticleChat(conversation.article.canonicalUrl);
      saveChatToken(
        data.conversation.id,
        data.writeToken,
        data.conversation.expiresAt
      );
      navigate(`/chat/${data.conversation.id}`);
    } catch (requestError) {
      setError(requestError.message);
      setLoading("");
    }
  }

  const isClosed = conversation?.status === "closed_scope";
  const canWrite = Boolean(conversation?.canWrite && writeToken && !isClosed);
  const images = (conversation?.media || []).filter((item) => (
    item.mediaType === "image"
  ));
  const selectedImage = images.find((item) => item.id === selectedMediaId) || null;
  const imageLabel = (mediaId) => {
    const image = images.find((item) => item.id === mediaId);
    return image ? `Image ${image.sourceOrder}` : null;
  };
  const suggestions = canWrite && messages.length === 0
    ? conversation?.article?.suggestedQuestions || []
    : [];

  if (loading === "page") {
    return (
      <div className="mx-auto max-w-4xl px-5 py-12 sm:px-8">
        <Skeleton className="h-[38rem]" />
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="mx-auto max-w-4xl px-5 py-16 sm:px-8">
        <Alert>{error || "Conversation not found."}</Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-5 pb-12 pt-8 sm:px-8 sm:pt-12">
      <Link to="/chats" className="inline-flex items-center gap-2 text-sm font-semibold text-ink/60 hover:text-ink">
        <ArrowLeft size={16} /> Back to community chats
      </Link>

      <header className="mt-7 rounded-3xl border border-line bg-elevated p-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{conversation.article.processingMode === "vector" ? "Article RAG" : "Direct context"}</Badge>
          <span className="text-xs text-ink/45">{conversation.article.sourceName}</span>
          {!canWrite && <Badge variant="outline">Read-only</Badge>}
        </div>
        <h1 className="mt-5 font-serif text-3xl leading-tight sm:text-4xl">
          {conversation.article.title}
        </h1>
        <a
          href={conversation.article.canonicalUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-moss hover:underline"
        >
          Open original article <ArrowUpRight size={15} />
        </a>
      </header>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <section className="order-2 rounded-3xl border border-line bg-[#111A16] p-4 sm:p-6 lg:order-1">
        <div className="min-h-[24rem] space-y-5">
          {messages.length === 0 && (
            <div className="mx-auto max-w-lg py-16 text-center">
              <Sparkles className="mx-auto text-acid" size={24} />
              <h2 className="mt-5 font-serif text-2xl">What would you like to understand?</h2>
              <p className="mt-2 text-sm leading-6 text-ink/50">
                Ask about the article, request a simple explanation, or explore a related concept.
              </p>
              {suggestions.length > 0 && (
                <div className="mt-6 flex flex-col gap-2">
                  {suggestions.map((suggestion) => (
                    <Button
                      key={suggestion}
                      type="button"
                      variant="outline"
                      className="h-auto justify-start whitespace-normal py-3 text-left"
                      onClick={() => setQuestion(suggestion)}
                    >
                      {suggestion}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}

          {messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              selectedMediaLabel={imageLabel(message.selectedMediaId)}
            />
          ))}

          {loading === "answer" && (
            <div className="flex justify-start">
              <div className="rounded-3xl rounded-bl-md border border-line bg-elevated px-5 py-4 text-sm text-ink/60">
                <LoaderCircle className="mr-2 inline animate-spin" size={15} />
                Checking the article and available evidence…
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {error && <Alert className="mt-5">{error}</Alert>}
        {isClosed && (
          <Alert className="mt-5">
            This conversation is closed because a question was outside the
            platform&apos;s AI learning scope. Start a new article chat to continue.
          </Alert>
        )}

        {!isClosed && !canWrite && (
          <div className="mt-5 flex flex-col items-start justify-between gap-4 rounded-2xl border border-line bg-elevated p-5 sm:flex-row sm:items-center">
            <div>
              <p className="font-semibold">This public chat is read-only.</p>
              <p className="mt-1 text-sm text-ink/50">
                Start a separate conversation to ask your own questions about this article.
              </p>
            </div>
            <Button
              type="button"
              className="shrink-0"
              onClick={handleStartNewChat}
              disabled={loading === "fork"}
            >
              {loading === "fork" ? (
                <><LoaderCircle className="mr-2 animate-spin" size={15} /> Starting</>
              ) : (
                <><CopyPlus className="mr-2" size={15} /> Start new chat</>
              )}
            </Button>
          </div>
        )}

        {canWrite && <form className="mt-6 border-t border-line pt-5" onSubmit={handleSubmit}>
          {selectedImage && (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-acid/30 bg-acid/10 px-3 py-2 text-xs">
              <span className="font-semibold text-acid">
                Selected: {imageLabel(selectedImage.id)}
              </span>
              <button
                type="button"
                className="text-ink/50 hover:text-ink"
                onClick={() => setSelectedMediaId(null)}
                aria-label="Remove selected image"
              >
                Remove
              </button>
            </div>
          )}
          <Textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={isClosed ? "This conversation is closed" : "Ask a question about this article…"}
            maxLength={2_000}
            disabled={loading === "answer"}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-ink/35">
              Answers identify whether they use the article, general knowledge, or external sources.
            </p>
            <Button
              type="submit"
              size="sm"
              disabled={loading === "answer" || !question.trim()}
            >
              Ask <Send className="ml-2" size={14} />
            </Button>
          </div>
        </form>}
      </section>
      <ArticleImagePanel
        images={images}
        selectedMediaId={selectedMediaId}
        onSelect={setSelectedMediaId}
        canAsk={canWrite}
        mediaStatus={conversation.article.mediaStatus}
        error={mediaError}
      />
      </div>
    </div>
  );
}
