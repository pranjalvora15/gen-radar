import { useEffect, useRef, useState } from "react";
import { FileText, LoaderCircle, Trash2, Upload } from "lucide-react";
import { useNavigate } from "react-router-dom";

import {
  createPaperWorkspace,
  deletePaperWorkspace,
  getActivePaperWorkspace
} from "../api";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import {
  clearPaperBlobs,
  deletePaperBlob,
  getPaperBlob,
  hashPdf,
  savePaperBlob
} from "../paperStorage";

const MAX_BYTES = 20 * 1024 * 1024;

export default function PapersPage() {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [workspace, setWorkspace] = useState(null);
  const [localPaper, setLocalPaper] = useState(null);
  const [state, setState] = useState("loading");
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    getActivePaperWorkspace()
      .then(async ({ workspace: value }) => {
        if (!active) return;
        if (!value) {
          await clearPaperBlobs();
          setState("ready");
          return;
        }
        setWorkspace(value);
        const local = await getPaperBlob(value.id);
        if (!active) return;
        setLocalPaper(local || null);
        setState("ready");
      })
      .catch((requestError) => {
        if (!active) return;
        setError(requestError.message);
        setState("ready");
      });
    return () => { active = false; };
  }, []);

  async function submitFile(file, restoring = false) {
    setError("");
    if (!file || file.type !== "application/pdf") {
      setError("Choose a PDF file.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("PDFs may be at most 20 MB.");
      return;
    }
    setState("working");
    try {
      setStage("Hashing the complete PDF…");
      const hash = await hashPdf(file);
      if (restoring) {
        if (hash !== workspace.document.hash) {
          throw new Error("This is not the same PDF used by the active workspace.");
        }
        const record = {
          workspaceId: workspace.id,
          documentHash: hash,
          filename: file.name,
          pdfBlob: file,
          expiresAt: workspace.expiresAt
        };
        await savePaperBlob(record);
        navigate(`/papers/${workspace.id}`);
        return;
      }
      setStage("Uploading and verifying the file…");
      const responsePromise = createPaperWorkspace(file, hash);
      setStage("Checking AI relevance, extracting pages, and indexing…");
      const { workspace: created } = await responsePromise;
      await savePaperBlob({
        workspaceId: created.id,
        documentHash: hash,
        filename: file.name,
        pdfBlob: file,
        expiresAt: created.expiresAt
      });
      navigate(`/papers/${created.id}`);
    } catch (uploadError) {
      setError(uploadError.message);
      setState("ready");
      setStage("");
    }
  }

  async function removeWorkspace() {
    if (!workspace) return;
    setState("working");
    setStage("Deleting the private workspace…");
    await deletePaperBlob(workspace.id).catch(() => {});
    try {
      await deletePaperWorkspace(workspace.id);
      setWorkspace(null);
      setLocalPaper(null);
      setState("ready");
      setStage("");
    } catch (deleteError) {
      setError(deleteError.message);
      setState("ready");
    }
  }

  return (
    <section className="mx-auto min-h-[70vh] max-w-4xl px-5 py-14 sm:px-8 sm:py-20">
      <div className="max-w-2xl">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-moss">Private paper workspace</p>
        <h1 className="mt-4 font-serif text-4xl tracking-tight sm:text-6xl">Read difficult AI papers with context.</h1>
        <p className="mt-5 leading-7 text-ink/60">Your original PDF stays in this browser. Extracted pages and vectors expire after 24 hours of inactivity.</p>
      </div>

      {error && <Alert className="mt-8">{error}</Alert>}

      <Card className="mt-10">
        <CardContent className="p-8 sm:p-10">
          {state === "loading" && <p className="text-sm text-ink/60">Checking for an active paper…</p>}

          {state === "working" && (
            <div className="flex items-center gap-4 py-8">
              <LoaderCircle className="animate-spin text-acid" />
              <div>
                <p className="font-semibold">Preparing your paper</p>
                <p className="mt-1 text-sm text-ink/55">{stage}</p>
              </div>
            </div>
          )}

          {state === "ready" && workspace && (
            <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
              <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-elevated text-acid"><FileText /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{workspace.document.title || workspace.originalFilename}</p>
                <p className="mt-1 text-sm text-ink/50">{workspace.document.pageCount || "—"} pages · {workspace.document.status}</p>
                {!localPaper && <p className="mt-2 text-sm text-amber-300">Reselect the original PDF to restore the browser viewer.</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {localPaper ? (
                  <Button onClick={() => navigate(`/papers/${workspace.id}`)}>Resume paper</Button>
                ) : (
                  <Button onClick={() => inputRef.current?.click()}>Reselect PDF</Button>
                )}
                <Button variant="outline" onClick={removeWorkspace} aria-label="Delete paper workspace"><Trash2 size={16} /></Button>
              </div>
            </div>
          )}

          {state === "ready" && !workspace && (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="grid w-full place-items-center rounded-2xl border border-dashed border-line px-6 py-16 text-center transition hover:border-moss/70 hover:bg-elevated/40"
            >
              <span className="grid size-14 place-items-center rounded-full bg-acid text-[#0E1512]"><Upload /></span>
              <span className="mt-5 font-serif text-2xl">Choose one AI white paper</span>
              <span className="mt-2 text-sm text-ink/50">PDF only · 20 MB · up to 150 pages</span>
            </button>
          )}

          <input
            ref={inputRef}
            className="hidden"
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              submitFile(file, Boolean(workspace && !localPaper));
            }}
          />
        </CardContent>
      </Card>
    </section>
  );
}
