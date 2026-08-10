import { Badge } from "./ui/badge";
import CitationList from "./CitationList";

const modeLabels = {
  article: "From article",
  general: "General explanation",
  media: "Article media",
  web_search: "External sources",
  combined: "Combined evidence",
  insufficient: "Insufficient evidence",
  guardrail: "Scope guardrail"
};

export default function ChatMessage({ message, selectedMediaLabel }) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={
          isUser
            ? "max-w-[85%] rounded-3xl rounded-br-md bg-acid px-5 py-4 text-sm leading-6 text-[#0E1512]"
            : "max-w-[92%] rounded-3xl rounded-bl-md border border-line bg-elevated px-5 py-5 text-sm leading-7 text-ink sm:max-w-[82%]"
        }
      >
        {isUser && selectedMediaLabel && (
          <span className="mb-2 block text-xs font-bold opacity-65">
            🖼 {selectedMediaLabel}
          </span>
        )}
        {!isUser && message.answerMode && (
          <Badge className="mb-3" variant="outline">
            {modeLabels[message.answerMode] || message.answerMode}
          </Badge>
        )}
        <p className="whitespace-pre-wrap">{message.content}</p>
        {!isUser && <CitationList citations={message.citations} />}
      </div>
    </div>
  );
}
