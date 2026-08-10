import { useState } from "react";
import { ArrowRight, Link2, LoaderCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { createArticleChat } from "../api";
import { saveChatToken } from "../chatTokens";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export default function ArticleUrlForm() {
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await createArticleChat(url.trim());
      saveChatToken(
        data.conversation.id,
        data.writeToken,
        data.conversation.expiresAt
      );
      navigate(`/chat/${data.conversation.id}`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-10 rounded-3xl border border-line bg-elevated p-5 sm:p-7">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-acid text-[#0E1512]">
          <Link2 size={17} />
        </span>
        <div>
          <h2 className="font-serif text-2xl">Chat with any technical article</h2>
          <p className="mt-1 text-sm leading-6 text-ink/55">
            Paste a public article URL. Gen Radar will read it and start a source-aware conversation.
          </p>
        </div>
      </div>

      <form className="mt-6 flex flex-col gap-3 sm:flex-row" onSubmit={handleSubmit}>
        <Input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/technical-article"
          aria-label="Article URL"
          required
          disabled={loading}
        />
        <Button
          type="submit"
          className="shrink-0"
          disabled={loading || !url.trim()}
        >
          {loading ? (
            <><LoaderCircle className="mr-2 animate-spin" size={16} /> Reading article</>
          ) : (
            <>Start chat <ArrowRight className="ml-2" size={16} /></>
          )}
        </Button>
      </form>
      {error && <Alert className="mt-4">{error}</Alert>}
      <p className="mt-4 text-xs leading-5 text-ink/40">
        Valid conversations are publicly readable for three days. Do not include
        personal, confidential, or private information in your questions.
      </p>
    </div>
  );
}
