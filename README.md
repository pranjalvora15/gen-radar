# Gen Radar

A technical learning platform that discovers GenAI engineering content and
lets learners start a source-aware conversation with any public technical
article.

## What is included

- React + Vite feed and update detail screens
- Tailwind CSS and the seven shadcn/ui components used by the interface
- Fastify API with JSON Schema, `loadUpdate` pre-handler, response/close hooks, and safe global errors
- PostgreSQL persistence with concurrency-safe article and keyword caches
- Exa discovery for practitioner experiments and independent technical blogs
- Semantic Scholar discovery for recent research papers and open-access metadata
- Gemini editorial ranking that rejects news, announcements, and marketing
- Interchangeable Python/FastAPI and JavaScript/Fastify AI services
- Fixed LangGraph workflows and LangChain structured output in both implementations
- Privacy-aware LangSmith tracing for public AI workflows and forced trace exclusion for private PDFs
- Gemini model configured only through `GEMINI_MODEL`
- Public article URL chat with anonymous conversation IDs
- Embeddings for every article: short articles answer from full context and
  long articles use pgvector retrieval
- AI-domain scope guardrail that closes clearly out-of-scope conversations
- Exact and semantic duplicate-question detection with cached-answer reuse
- Article image analysis, on-demand YouTube/direct-video analysis, and media citations
- Supervisor, Document, Media, Exa Research, and Reviewer agents in LangGraph
- Three suggested first questions and source-aware article/image/video/web citations
- Anonymous chat history with sliding three-day expiry and hourly deletion
- Public community chat feed with creator-only anonymous write tokens
- Private IndexedDB-backed AI white-paper reader with page-aware RAG,
  selectable text and figure explanations, and 24-hour workspace expiry

## Architecture

```mermaid
flowchart LR
    User[Reader] --> Web[React and Vite]
    Web --> API[Fastify API]

    API --> DB[(PostgreSQL and pgvector)]
    API --> Exa[Exa discovery and extraction]
    API --> Scholar[Semantic Scholar]
    API --> AI[Python FastAPI AI service]

    AI --> Chain[LangChain structured output]
    AI --> Graph[LangGraph workflows]
    Graph -. public traces only .-> LangSmith[LangSmith observability]
    Graph --> Gemini[Gemini Flash-Lite and Flash]
    Chain --> Embeddings[Gemini embeddings]
    Embeddings --> DB

    DB --> API
    API --> Web
```

## Prerequisites

- Node.js 20+
- Python 3.11+ when using the Python AI service
- PostgreSQL 15+ with the pgvector extension
- Exa and Google AI API keys
- Optional Semantic Scholar API key for higher research API limits

## 1. Install

From the repository root:

```bash
npm install
python -m venv .venv
```

Activate the virtual environment:

```bash
# macOS/Linux
source .venv/bin/activate

# Windows PowerShell
.venv\Scripts\Activate.ps1
```

Then install the Python AI service:

```bash
python -m pip install -r ai-service/requirements.txt
```

## 2. Configure

Copy the environment examples:

```bash
cp server/.env.example server/.env
cp ai-service/.env.example ai-service/.env
cp ai-service-js/.env.example ai-service-js/.env
```

On Windows PowerShell:

```powershell
Copy-Item server/.env.example server/.env
Copy-Item ai-service/.env.example ai-service/.env
Copy-Item ai-service-js/.env.example ai-service-js/.env
```

Set `DATABASE_URL` and `EXA_API_KEY` in `server/.env`. The Python service also
loads this file, so the Research Agent can reuse that Exa key when article and
media evidence is insufficient. Optionally set
`SEMANTIC_SCHOLAR_API_KEY` for dedicated authenticated paper-search limits. Set
`GOOGLE_API_KEY` in the environment file for the AI implementation you want to
use. Phase 3 article chat requires the Python AI service. Keep:

```text
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_JUDGE_MODEL=gemini-3.5-flash
GEMINI_MAX_ATTEMPTS=3
GEMINI_VALIDATION_ATTEMPTS=2
GEMINI_RETRY_BASE_SECONDS=1
GEMINI_RETRY_MAX_SECONDS=4
EMBEDDING_MODEL=gemini-embedding-2
PAPER_EMBEDDING_MODEL=gemini-embedding-001
EMBEDDING_DIMENSIONS=768
EMBEDDING_BATCH_SIZE=100
PAPER_EMBEDDING_BATCH_SIZE=10
PAPER_EMBEDDING_MIN_INTERVAL_SECONDS=21
PAPER_EMBEDDING_MAX_ATTEMPTS=4
FEED_REFRESH_INTERVAL_HOURS=48
FEED_REFRESH_FORCE=false
ARTICLE_MAX_CHARS=100000
PAPER_WORKSPACE_SECRET=replace-with-a-long-random-secret
CLEANUP_API_KEY=replace-with-a-separate-random-secret
PAPER_MAX_BYTES=20971520
PAPER_WORKSPACE_EXPIRY_HOURS=24
PAPER_UPLOAD_LIMIT=3
DISABLE_PAPER_UPLOAD_LIMIT=false
PAPER_AI_REQUEST_LIMIT=30
PAPER_WORKSPACE_ACTION_LIMIT=20
PAPER_ACTIVE_WORKSPACE_LIMIT=100
PAPER_RELEVANCE_THRESHOLD=0.70
LANGSMITH_PUBLIC_TRACING=false
LANGSMITH_API_KEY=
LANGSMITH_PROJECT=gen-radar-development
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_HIDE_INPUTS=true
LANGSMITH_HIDE_OUTPUTS=true
LANGSMITH_TRACING_SAMPLING_RATE=1.0
```

The Python service loads `ai-service/.env`. The JavaScript service loads
`ai-service-js/.env` and falls back to `ai-service/.env` when its own Google key
is not configured.

### Optional LangSmith observability

LangSmith can trace the public LangChain and LangGraph workflows used for
article explanations, routing, evidence grading, guardrails, agent supervision,
and answer generation. Create an API key in LangSmith under **Settings -> API
Keys**, then configure the Python AI service:

```text
LANGSMITH_PUBLIC_TRACING=true
LANGSMITH_API_KEY=replace-with-your-langsmith-key
LANGSMITH_PROJECT=gen-radar-production
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_HIDE_INPUTS=true
LANGSMITH_HIDE_OUTPUTS=true
LANGSMITH_TRACING_SAMPLING_RATE=1.0
```

`LANGSMITH_WORKSPACE_ID` is needed only when the API key can access more than
one workspace. Use the endpoint assigned to the LangSmith region instead of the
US endpoint when applicable.

Production tracing is deliberately opt-in through
`LANGSMITH_PUBLIC_TRACING`; do not enable global tracing as a substitute. With
the safe production defaults above, LangSmith receives workflow structure,
latency, model runs, tags, and non-sensitive metadata, but input and output
payloads are hidden. Local development can set `LANGSMITH_HIDE_INPUTS=false`
and `LANGSMITH_HIDE_OUTPUTS=false` when using non-sensitive test content.

All private white-paper operations explicitly disable LangSmith tracing,
including PDF admission, page/query embeddings, selected-text explanations,
figure analysis, and paper questions. This preserves the product guarantee
that private PDF content, questions, and generated explanations are not sent to
the observability service.

## 3. Initialize PostgreSQL

Create the database and apply the schema:

```bash
createdb genai_updates
psql postgresql://postgres:postgres@localhost:5432/genai_updates -f server/sql/init.sql
```

Or use the configured connection string:

```bash
npm --prefix server run db:init
```

The idempotent schema also creates `article_media`, question hashes and
embeddings, HNSW indexes, guardrail state, suggested questions, and expiration
timestamps. PostgreSQL must have pgvector installed.

## 4. Choose and start an AI implementation

Python runs on port `8010` and supports all phases. The JavaScript AI service
runs on port `8001` and remains available for the Phase 1 explanation and
ranking contract only.

```bash
npm run dev:python
```

Or:

```bash
npm run dev:javascript
```

These commands start the client, main Fastify API, and selected AI service with
the correct URL. To run them separately, use:

```bash
npm --workspace server run dev
npm --workspace client run dev

# Python AI
python -m uvicorn app:app --app-dir ai-service --port 8010

# JavaScript AI
npm --workspace ai-service-js run dev
```

Run the Python AI service with one Uvicorn worker. Its shared `asyncio`
coordinator serializes Gemini generation and retries temporary provider
failures. Selected-image analysis is an interactive request, not a background
job.
Multiple AI-service workers or instances require a shared Redis-backed queue or
distributed limiter because an in-memory lock is local to one process.

When running processes separately, set `AI_SERVICE_URL` in `server/.env` to
`http://localhost:8010` for Python or `http://localhost:8001` for JavaScript,
then restart Fastify.

Health checks:

- Fastify: `http://localhost:3000/api/health`
- Python AI: `http://localhost:8010/health`
- JavaScript AI: `http://localhost:8001/health`
- Client: `http://localhost:5173`

## Continuous integration and deployment

The `CI` GitHub Actions workflow runs for pull requests into `main`, pushes to
`main`, and manual dispatches. It installs the locked JavaScript dependencies
and runs `npm run check`, which validates the Fastify source, creates the Vite
production build, and compiles the Python AI source. It does not need production
API keys because it does not call external services.

Both Render services remain linked to the repository's `main` branch. Configure
their **Auto-Deploy** setting as **After CI Checks Pass** so Render deploys the
Fastify/React application and Python AI service only after the `Build and
validate` GitHub check succeeds. A failed CI run therefore leaves the current
production deployments unchanged.

Production health endpoints:

- Fastify/React: `https://gen-radar-app.onrender.com/api/health`
- Python AI: `https://gen-radar-ai.onrender.com/health`

## 5. Discover and refresh updates

`GET /api/updates` returns the latest ten stored articles and the current
singleton refresh state from PostgreSQL. It never starts a detached background
job, so local development and Render request restarts cannot interrupt feed
discovery or leave production waiting on a request-owned process.

The `Refresh learning feed` GitHub Actions workflow runs every six hours. The
workflow executes the repository's Node.js refresh script on a temporary GitHub
runner. The script atomically claims the job only when the last successful
refresh is at least 48 hours old, then calls Exa and the deployed Python AI
service before inserting accepted articles into PostgreSQL. Runs inside the
48-hour freshness window exit successfully without calling Exa or Gemini.

Each refresh requests a larger discovery pool, normalizes URLs, removes URLs
already stored in PostgreSQL before editorial ranking, and selects at most ten
new articles with a maximum of two per domain. Only selected articles are fully
extracted. The AI service creates one grounded seven-to-eight sentence
`displaySummary` per selected article, and Fastify stores the complete accepted
content plus extraction metadata. A failed refresh leaves the existing feed
available, records the failure, and can be retried by the next scheduled run.

Discovery can also be requested from the local command line:

```bash
npm run refresh
```

The command respects `FEED_REFRESH_INTERVAL_HOURS`. To deliberately bypass the
freshness interval in PowerShell, run:

```powershell
$env:FEED_REFRESH_FORCE="true"
npm run refresh
```

The scheduled workflow uses the existing `CLEANUP_DATABASE_URL` repository
secret plus `EXA_API_KEY` and `AI_INTERNAL_API_KEY` repository secrets. The
internal key must match the value configured on the deployed Python AI service.
`AI_SERVICE_URL` can be set as a repository variable; when omitted it defaults
to the deployed Gen Radar Python service URL. Local development does not
automatically refresh the production feed.

It collects recent technical blogs and experiments with Exa, adds recent papers
from Semantic Scholar's bulk-search endpoint, and sends the candidate batch to
the selected AI service. Semantic Scholar `429` responses are retried after 2,
5, and 10 seconds. If the service remains unavailable, discovery uses a
successful response cached in PostgreSQL for up to seven days, then falls back
to Exa's research-paper results. The editorial model rejects news,
announcements, customer stories, SEO content, and marketing; scores technical
depth, novelty, evidence, and learning value; then selects at most ten articles
with a maximum of two per domain.

## 6. Verify the complete flow

1. Open the feed and select an update.
2. Click **Explain this update**. The first click calls the AI service and stores the structured result.
3. Click a keyword. The first click generates and stores a contextual explanation.
4. Open the same update and keyword again. Both responses should return from PostgreSQL with `"cached": true`.

The same stored `displaySummary` is used on both surfaces: home cards show a
CSS-clamped preview, while the article page shows the complete summary below
the heading. There are not separate card and detail summaries.

Article explanations are generated only on demand. Before the first
explanation, older or known-truncated records are re-extracted once. The first
request atomically claims generation and stores the result; concurrent visitors
wait for that shared result instead of issuing duplicate Gemini calls. Later
visitors receive the global PostgreSQL cache. New records already carry their
full extraction, so the explanation call can use up to the configured
`ARTICLE_MAX_CHARS` instead of the former 15,000-character cut-off. Discovery
uses one batch AI call to classify and rank candidates and one batch call to
create display summaries for the accepted articles.

## 7. Phase 3: research chat with an article

1. Start the Python implementation with `npm run dev:python`.
2. Paste a public technical article URL into the form on the home page.
3. Gen Radar extracts the text and available media links with Exa, embeds the
   article, caches exactly three suggested questions, and immediately creates
   an anonymous conversation. The owner&apos;s chat page opens immediately while a
   lightweight discovery request can add more article-image URLs asynchronously.
   Every discovered article image appears as a selectable thumbnail; discovery
   does not send images to Gemini.
   Medium articles additionally use the author&apos;s public RSS item for the real
   title and article-body image URLs, preventing recommendation cards, avatars,
   and publication links from entering the image panel.
   When Exa returns no usable images for a protected publication, Gen Radar
   reads the article Markdown through `r.jina.ai`. If an image host blocks
   direct downloads, `wsrv.nl` supplies the preview and on-demand vision bytes;
   PostgreSQL still retains the original article image URL as the source.
4. Clicking a suggestion fills the input without sending it. Every submitted
   question first gets normalized and SHA-256 hashed. Exact repeats reuse the
   old answer before any new embedding or LLM call.
5. The scope guardrail allows AI/ML questions and article prerequisites.
   Medium/high-confidence unrelated questions close the chat; ambiguous
   questions ask the user to rephrase.
6. One question embedding powers both semantic duplicate detection and
   long-article retrieval. Semantically repeated questions reuse an answer only
   when the article and content version match.
7. The evidence grader decides whether article/media evidence is enough.
   Exa Research activates only for missing, current, comparative, or
   verification evidence.
8. The Supervisor combines the conditionally invoked Document, Media, and
   Research specialists; the Reviewer gets one correction pass.
9. Useful article images appear in a responsive image panel beside the chat.
   Selecting one adds an image chip to the question; Fastify validates its
   `mediaId`, requests question-specific visual analysis, and gives only that
   selected image evidence to the Media Agent. Public readers can inspect the
   images but cannot submit questions.

### Article-chat agentic RAG flow

```mermaid
flowchart TD
    Question[User question] --> Hash[Exact question hash lookup]
    Hash -->|Exact duplicate| Cached[Return cached answer]
    Hash -->|New question| Guardrail[AI-domain scope guardrail]

    Guardrail -->|Outside AI domain| Closed[Close the conversation]
    Guardrail -->|Ambiguous| Rephrase[Ask the user to rephrase]
    Guardrail -->|Allowed| Embed[Create one question embedding]

    Embed --> Semantic[Semantic duplicate search]
    Semantic -->|Similar duplicate| Cached
    Semantic -->|New meaning| Retrieval[Article pgvector retrieval and selected media]

    subgraph AgenticRAG[Agentic RAG routing and specialist execution]
        Retrieval --> Router[Evidence grader and routing agent]
        Router -->|Article evidence| DocumentAgent[Document subagent]
        Router -->|Selected image or video| MediaAgent[Media subagent]
        Router -->|Missing or current evidence| ResearchAgent[Exa Research subagent]
        Router -->|Article evidence insufficient| GeneralPath[General-knowledge path]

        DocumentAgent --> Supervisor[Supervisor agent]
        MediaAgent --> Supervisor
        ResearchAgent --> Supervisor
        GeneralPath --> Supervisor
        Supervisor --> Reviewer[Reviewer agent]
    end

    Reviewer --> Answer[Labelled answer with citations]
    Answer --> CacheAnswer[(Cache answer and evidence)]
```

### On-demand image flow: Fastify and Python concurrency

Fastify will store and display discovered article-image URLs without sending
every image to Gemini. Only an image explicitly selected with a user question
is analyzed with that question and the article context. Fastify does not create
or coordinate a background LLM image lineup, so no Fastify chat-priority gate
is needed.

#### Is Python `asyncio` still needed?

Yes, but its role is smaller. It does not manage a background image lineup
because Fastify does not create one. It remains useful for:

- handling concurrent AI requests from multiple users;
- waiting for Gemini without blocking FastAPI;
- ensuring Gemini generation calls do not overlap excessively;
- retrying temporary HTTP `429`, `503`, and timeout errors; and
- coordinating Flash and Flash-Lite calls that share the same Google project
  quota.

For example, two separate chats can reach the AI service at nearly the same
time:

```text
User A asks a question
→ Fastify A calls Python
→ Python acquires the Gemini lock

User B asks another question
→ Fastify B calls Python
→ Python places B behind A
→ Fastify B asynchronously awaits the Python response

User A finishes
→ Python releases the Gemini lock
→ User B acquires the lock and calls Gemini
→ Python returns B's result to Fastify B
→ Fastify B returns the answer to User B
```

Fastify does not manage the cross-chat Gemini queue. Each Fastify route simply
awaits its own HTTP call to Python, so the user's HTTP request remains pending
while the Node.js event loop stays free to serve unrelated requests. Python's
shared `asyncio` coordinator manages access to Gemini, bounded retries, and the
order in which waiting model operations continue. React shows an answering
state during this time.

The in-memory coordinator applies to one Python process. If the AI service is
later deployed with multiple Uvicorn workers or multiple service instances,
the lock must be replaced by a shared queue or distributed limiter such as
Redis. Fastify-to-Python timeouts and the maximum waiting queue must also be
bounded so an overloaded AI service returns a controlled busy response instead
of leaving requests open indefinitely.

Messages remain normal PostgreSQL rows. Article chunks and user-question
embeddings use pgvector. Conversations have a sliding three-day expiry:
expired chats are hidden immediately; startup cleanup and the external hourly
cleanup job delete them with cascading messages, hashes, and question vectors. Articles, chunks, and
media analyses are retained. User messages may also store `selected_media_id`.
Exact-answer hashes include
the selected image, and semantic duplicate lookup is filtered by image, so the
same wording about Image 1 and Image 2 cannot reuse the wrong cached answer.

Run cleanup manually with:

```bash
npm --prefix server run cleanup:chats
```

### Chat limits

Three independent limits protect article extraction, LLM usage, and conversation
context:

- **10 new chats per IP address per hour.** For example, after someone creates
  chats for ten article URLs, an attempt to create an eleventh chat within the
  same hour returns HTTP `429`.
- **30 questions per IP address per hour.** This total is shared across all
  conversations from that address. For example, 15 questions in Chat A plus 15
  questions in Chat B use the allowance; the next question returns HTTP `429`
  until the hourly window resets.
- **20 questions per conversation.** After a chat reaches 20 user questions, it
  remains readable but accepts no more questions. The hourly reset does not
  reopen it, so the user must start a new conversation to continue.

A combined example is 20 questions in Chat A and 10 in Chat B. The IP address
has reached its 30-question hourly allowance, while Chat A has also permanently
reached its 20-question conversation limit. After the hourly reset, the user can
continue Chat B but must create a new conversation instead of adding to Chat A.

The defaults can be changed with:

```env
ARTICLE_CHAT_CREATE_LIMIT=10
ARTICLE_CHAT_MESSAGE_LIMIT=30
ARTICLE_MEDIA_DISCOVERY_LIMIT=10
CHAT_QUESTION_LIMIT=20
```

### Public community chats

A conversation becomes visible in the public learning feed after its first
non-guardrail answer. Empty chats and conversations closed by the AI scope
guardrail are not listed. Public chats remain readable through their direct URL
until the existing three-day expiry removes them.

The creator receives a random write token once when the conversation is
created. The browser keeps that token in `localStorage` until the chat expires;
PostgreSQL stores only its SHA-256 hash. Public readers never receive the token
and see a read-only conversation. They can use **Start new chat** to create a
separate conversation for the same cached article.

Run the database initializer after pulling this change so existing databases
receive the nullable token-hash column and public-list index:

```bash
npm --prefix server run db:init
```

Existing conversations created before token protection remain readable but are
read-only. There are still no user accounts, identity authentication, manual
publishing, or manual Research button.

## 8. Phase 4: private AI white-paper reader

Open **White papers** and upload one PDF of at most 20 MB and 150 pages. The
browser hashes the complete PDF bytes with SHA-256. Fastify independently
calculates the same hash while streaming the upload to a temporary file and
rejects a mismatch. PostgreSQL uses its unique `file_hash` index to reuse an
exact duplicate without extracting or embedding it again; it never loads all
stored hashes for comparison.

### Private white-paper RAG flow

```mermaid
flowchart TD
    PDF[User selects one PDF] --> BrowserHash[Browser SHA-256 hash]
    PDF --> IndexedDB[(Original PDF in browser IndexedDB)]
    BrowserHash --> Upload[Fastify streaming upload and hash verification]
    Upload --> Duplicate{Exact document hash exists?}

    Duplicate -->|Ready duplicate| Workspace[Private paper workspace]
    Duplicate -->|New or retryable| Inspect[Temporary PDF inspection]
    Inspect --> Admission[AI relevance and PDF guardrails]
    Admission -->|Rejected, encrypted, scanned, or non-AI| Reject[Reject document]
    Admission -->|Accepted| Pages[Extract page-aware text and chunks]
    Pages --> EmbedPages[Gemini document embeddings]
    EmbedPages --> Vectors[(PostgreSQL pages and pgvector)]
    Vectors --> Workspace
    Workspace --> Reader[React PDF reader]

    Reader --> Interaction{User interaction}
    Interaction -->|Selected text| Selection[Selection plus surrounding page context]
    Interaction -->|Selected figure| Figure[Gemini Flash figure explanation]
    Interaction -->|Question| Mode{Answer mode}

    Mode -->|General knowledge| General[Skip retrieval and answer from Gemini]
    Mode -->|Paper first| QueryEmbedding[Create query embedding]
    QueryEmbedding --> Retrieve[Retrieve top five paper chunks]
    Retrieve --> Grade[Evidence sufficiency grader]
    Grade -->|Sufficient| PaperAnswer[Paper-grounded answer with page citations]
    Grade -->|Insufficient| Fallback[Clearly labelled general-knowledge fallback]

    Selection --> Ephemeral[Show latest result only]
    Figure --> Ephemeral
    General --> Ephemeral
    PaperAnswer --> Ephemeral
    Fallback --> Ephemeral
    Ephemeral --> Privacy[No PDF questions, answers, or crops persisted]

    Workspace --> Expiry[24-hour sliding expiry]
    Expiry --> Cleanup[Delete workspace, orphaned pages, and vectors]
```

The original PDF is stored only as a Blob in browser IndexedDB. Fastify deletes
its temporary copy after inspection. PostgreSQL stores document metadata,
page-numbered extracted text, chunks, and 768-dimensional pgvector embeddings.
PDF text and PDF questions use the text-only `gemini-embedding-001` model while
article chat keeps `gemini-embedding-2`; vectors from the two spaces are never
mixed. A quota-aware PDF embedding queue sends 10 chunks at a time, spaces
provider calls by 21 seconds, and retries transient quota responses. This makes
large papers slower to index but avoids both oversized requests and rapid
request/token bursts on free-tier projects.
No PDF question, answer, selected crop, explanation, or chat history is saved.
PDF workspaces are private and never appear in Community chats.

The Python service rejects encrypted, malformed, scanned/image-only, over-limit,
and non-AI PDFs. Gemini Flash-Lite admits a paper only when its structured AI
relevance confidence is at least `0.70`. Text selection uses roughly 2,000
characters on either side and retrieves up to three extra chunks only when the
selection is ambiguous. The question panel offers **Paper first** and **General
knowledge** modes. Paper first retrieves five page-aware chunks and grades their
sufficiency; supported answers use **From the paper** with page citations, while
missing evidence automatically falls back to **General knowledge — this answer
is not established by the uploaded paper.** General knowledge mode skips query
embedding and PDF retrieval and answers directly from Gemini's AI knowledge.
Figure crops are analyzed on demand with Gemini Flash and are not persisted.

One anonymous browser can own one active PDF workspace. The raw ownership token
is an `HttpOnly` cookie; PostgreSQL stores only its SHA-256 hash. Defaults are
three uploads per IP per rolling 24 hours, 30 PDF AI requests per IP per hour,
20 successful AI actions per workspace, and 100 active workspaces globally.
For repeated local testing, set `DISABLE_PAPER_UPLOAD_LIMIT=true`. Fastify honors
this only when `NODE_ENV` is not `production`; production always enforces the
rolling upload limit.

Workspaces expire 24 hours after the last page change or AI interaction.
Gen Radar does not run an expiry timer in the browser. On the next site startup,
it reads IndexedDB and deletes records whose `expiresAt` has passed. A `410`
response and manual deletion also remove the local Blob. If the browser stays
closed beyond expiry, deletion occurs on the next Gen Radar visit.

Run server cleanup at startup and from an external hourly cron:

```bash
npm --prefix server run cleanup:chats
```

The same cleanup command removes expired chats, expired paper workspaces,
orphaned paper pages/vectors, and old upload-attempt records. The secured
`POST /api/internal/cleanup-expired` endpoint is also available to an external
cron using the `x-cleanup-key` header.

## Checks

```bash
npm run check
npm test
```

The server suite covers route validation, the pre-handler, article cache hits,
first-click generation, keyword membership, normalized keyword caching,
exact answer reuse, guardrail closure, learning-feed selection, domain diversity,
and database deduplication. Both AI implementations have structured-output
validation tests; the JavaScript suite also verifies HTTP contract parity.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Fastify health |
| `GET` | `/api/updates` | Recent updates |
| `GET` | `/api/updates/:id` | One update |
| `POST` | `/api/updates/:id/explain` | Cached or new article explanation |
| `POST` | `/api/updates/:id/keywords/explain` | Cached or new contextual keyword explanation |
| `POST` | `/api/article-chats` | Extract an article and create a conversation |
| `GET` | `/api/article-chats?limit=12&offset=0` | List active public learning chats |
| `GET` | `/api/article-chats/:conversationId` | Load article metadata and messages |
| `POST` | `/api/article-chats/:conversationId/media/discover` | Claim asynchronous article-image URL discovery using `x-chat-token`; no Gemini call |
| `POST` | `/api/article-chats/:conversationId/messages` | Ask a source-aware question using `x-chat-token` |
| `POST` | `/api/paper-workspaces` | Verify, inspect, index, and create a private PDF workspace |
| `GET` | `/api/paper-workspaces/active` | Return the cookie owner's active PDF workspace |
| `GET` | `/api/paper-workspaces/:workspaceId` | Load one private workspace and processing status |
| `PATCH` | `/api/paper-workspaces/:workspaceId/reader-state` | Save page/zoom and extend genuine activity |
| `POST` | `/api/paper-workspaces/:workspaceId/explain-selection` | Explain selected text with surrounding context |
| `POST` | `/api/paper-workspaces/:workspaceId/explain-figure` | Explain one temporary page crop |
| `POST` | `/api/paper-workspaces/:workspaceId/questions` | Run page-aware RAG with labelled fallback |
| `DELETE` | `/api/paper-workspaces/:workspaceId` | Delete the private workspace and local-owner cookie |
| `POST` | `/api/internal/cleanup-expired` | Secured external expiry cleanup trigger |
| `GET` | `/health` | Selected AI service health |
| `POST` | `/ai/explain-article` | Internal article workflow |
| `POST` | `/ai/explain-keyword` | Internal keyword workflow |
| `POST` | `/ai/rank-candidates` | Internal learning-feed editorial ranking |
| `POST` | `/ai/summarize-feed-articles` | Generate stored seven-to-eight sentence feed summaries |
| `POST` | `/ai/embed-documents` | Split and embed a long article |
| `POST` | `/ai/embed-query` | Embed an article-chat question |
| `POST` | `/ai/route-question` | Grade evidence and select an answer route |
| `POST` | `/ai/answer-question` | Generate a route-aware answer |
| `POST` | `/ai/judge-answer` | Conditionally verify an answer |
| `POST` | `/ai/summarize-conversation` | Compact older conversation context |
| `POST` | `/ai/check-question-scope` | Enforce the AI/article domain guardrail |
| `POST` | `/ai/suggest-questions` | Create three cached first questions |
| `POST` | `/ai/analyze-media` | Analyze a selected article image with its question, or requested video context |
| `POST` | `/ai/grade-evidence` | Decide if article/media evidence is sufficient |
| `POST` | `/ai/supervise-answer` | Run specialist, research, supervisor, and reviewer agents |
| `POST` | `/ai/inspect-paper` | Extract pages and classify AI relevance |
| `POST` | `/ai/embed-paper-pages` | Create page-preserving chunks and embeddings |
| `POST` | `/ai/explain-paper-selection` | Explain a selected passage |
| `POST` | `/ai/explain-paper-figure` | Explain a selected figure crop |
| `POST` | `/ai/answer-paper-question` | Grade paper evidence and generate a labelled answer |
Four twenty one phave twenty renge motis magano little net items request you didn't reply on the WhatsApp what do you think we are free? The whole day will see the WhatsApp did the minister have followed off
Fastify owns PostgreSQL, URL extraction, retrieval, caching, limits, and chat
lifecycle. Python owns prompts, embeddings, multimodal model calls, LangGraph
agents, structured validation, and the narrowly scoped Exa research tool.
