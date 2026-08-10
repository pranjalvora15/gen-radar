import { lazy, Suspense } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import HomePage from "./pages/HomePage";
import ArticleChatPage from "./pages/ArticleChatPage";
import ChatsPage from "./pages/ChatsPage";
import UpdatePage from "./pages/UpdatePage";
import PapersPage from "./pages/PapersPage";
const PaperReaderPage = lazy(() => import("./pages/PaperReaderPage"));

function Layout({ children }) {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="border-b border-line/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
          <Link to="/" className="group flex items-center gap-3" aria-label="Signal home">
            <span className="grid size-9 place-items-center rounded-full bg-acid text-xs font-bold text-[#0E1512]">GR</span>
            <span className="text-sm font-semibold tracking-tight">Gen Radar</span>
          </Link>
          <nav className="flex items-center gap-5 text-xs font-medium text-ink/60">
            <Link className="transition hover:text-ink" to="/papers">White papers</Link>
            <Link className="transition hover:text-ink" to="/chats">Community chats</Link>
            <a
              className="flex items-center gap-1.5 transition hover:text-ink"
              href="https://github.com"
              target="_blank"
              rel="noreferrer"
            >
              Trusted sources <ArrowUpRight size={14} />
            </a>
          </nav>
        </div>
      </header>
      <main>{children}</main>
      <footer className="mx-auto mt-20 flex max-w-6xl flex-col gap-3 border-t border-line px-5 py-8 text-xs text-ink/50 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p>Gen Radar turns technical writing into useful understanding.</p>
        <p>Explanations are generated from source text only.</p>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/chat/:conversationId" element={<ArticleChatPage />} />
        <Route path="/chats" element={<ChatsPage />} />
        <Route path="/updates/:id" element={<UpdatePage />} />
        <Route path="/papers" element={<PapersPage />} />
        <Route path="/papers/:workspaceId" element={(
          <Suspense fallback={<div className="grid min-h-[65vh] place-items-center text-sm text-ink/50">Loading PDF reader…</div>}>
            <PaperReaderPage />
          </Suspense>
        )} />
      </Routes>
    </Layout>
  );
}
