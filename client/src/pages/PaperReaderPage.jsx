import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Crop,
  LoaderCircle,
  Send,
  Trash2,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  askPaperQuestion,
  deletePaperWorkspace,
  explainPaperFigure,
  explainPaperSelection,
  getPaperWorkspace,
  updatePaperReaderState
} from "../api";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import {
  deletePaperBlob,
  getPaperBlob,
  updatePaperExpiry
} from "../paperStorage";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

function ResultCard({ result }) {
  if (!result) return null;
  const value = result.value;
  return (
    <div className="rounded-2xl border border-line bg-cream p-5">
      <Badge>{result.label}</Badge>
      {result.type === "selection" && (
        <>
          <p className="mt-4 whitespace-pre-wrap leading-7">{value.simpleExplanation}</p>
          <h3 className="mt-6 text-xs font-bold uppercase tracking-[0.16em] text-moss">Why it matters</h3>
          <p className="mt-2 leading-7 text-ink/75">{value.whyItMatters}</p>
          {value.example && <p className="mt-4 rounded-xl bg-elevated p-4 text-sm leading-6"><strong>Example:</strong> {value.example}</p>}
          {value.importantTerms?.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-2">{value.importantTerms.map((term) => <Badge key={term} variant="outline">{term}</Badge>)}</div>
          )}
        </>
      )}
      {result.type === "figure" && (
        <>
          <p className="mt-4 whitespace-pre-wrap leading-7">{value.explanation}</p>
          <p className="mt-4 text-sm leading-6 text-ink/70">{value.relationToPaper}</p>
          {value.keyDetails?.length > 0 && <ul className="mt-4 list-disc space-y-2 pl-5 text-sm">{value.keyDetails.map((item) => <li key={item}>{item}</li>)}</ul>}
          {value.uncertainty && <p className="mt-4 text-sm text-amber-200">Uncertainty: {value.uncertainty}</p>}
        </>
      )}
      {result.type === "answer" && (
        <p className="mt-4 whitespace-pre-wrap leading-7">{value.answer}</p>
      )}
      {value.pageCitations?.length > 0 && (
        <p className="mt-5 text-xs text-ink/45">Pages {value.pageCitations.join(", ")}</p>
      )}
    </div>
  );
}

export default function PaperReaderPage() {
  const { workspaceId } = useParams();
  const navigate = useNavigate();
  const pageRef = useRef(null);
  const [workspace, setWorkspace] = useState(null);
  const [paperRecord, setPaperRecord] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [selectedText, setSelectedText] = useState("");
  const [question, setQuestion] = useState("");
  const [answerMode, setAnswerMode] = useState("paper");
  const [result, setResult] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [figureMode, setFigureMode] = useState(false);
  const [crop, setCrop] = useState(null);
  const [dragStart, setDragStart] = useState(null);

  useEffect(() => {
    let active = true;
    let poll;
    async function load() {
      try {
        const [{ workspace: value }, local] = await Promise.all([
          getPaperWorkspace(workspaceId),
          getPaperBlob(workspaceId)
        ]);
        if (!active) return;
        setWorkspace(value);
        setPaperRecord(local || null);
        setPageNumber(value.currentPage || 1);
        setZoom(value.zoom || 1);
        setState("ready");
        if (value.document.status === "processing") {
          poll = setTimeout(load, 3000);
        } else if (["rejected", "failed"].includes(value.document.status)) {
          await deletePaperBlob(workspaceId);
          setError(value.document.status === "rejected"
            ? "This document was not accepted as an AI white paper."
            : "The paper could not be processed. Delete it and try again.");
        }
      } catch (requestError) {
        if (!active) return;
        if (requestError.status === 410 || requestError.status === 404) {
          await deletePaperBlob(workspaceId).catch(() => {});
        }
        setError(requestError.message);
        setState("ready");
      }
    }
    load();
    return () => {
      active = false;
      clearTimeout(poll);
    };
  }, [workspaceId]);

  async function persistReader(nextPage, nextZoom) {
    try {
      const response = await updatePaperReaderState(workspaceId, {
        currentPage: nextPage,
        zoom: nextZoom
      });
      await updatePaperExpiry(workspaceId, response.expiresAt);
      setWorkspace((value) => value ? { ...value, expiresAt: response.expiresAt } : value);
    } catch (requestError) {
      if (requestError.status === 410) {
        await deletePaperBlob(workspaceId).catch(() => {});
        navigate("/papers");
      } else {
        setError(requestError.message);
      }
    }
  }

  function changePage(next) {
    const bounded = Math.max(1, Math.min(numPages || workspace.document.pageCount, next));
    setPageNumber(bounded);
    setSelectedText("");
    setCrop(null);
    persistReader(bounded, zoom);
  }

  function changeZoom(next) {
    const bounded = Math.max(0.5, Math.min(2, Number(next.toFixed(2))));
    setZoom(bounded);
    setCrop(null);
    persistReader(pageNumber, bounded);
  }

  async function runAction(action) {
    setError("");
    setState("answering");
    try {
      const response = await action();
      await updatePaperExpiry(workspaceId, response.expiresAt);
      setWorkspace((value) => value ? {
        ...value,
        expiresAt: response.expiresAt,
        aiActionCount: response.aiActionCount
      } : value);
      setState("ready");
      return response;
    } catch (requestError) {
      if (requestError.status === 410) {
        await deletePaperBlob(workspaceId).catch(() => {});
        navigate("/papers");
        return null;
      }
      setError(requestError.message);
      setState("ready");
      return null;
    }
  }

  async function explainSelection() {
    const text = selectedText.trim();
    if (!text) return;
    const response = await runAction(() => explainPaperSelection(workspaceId, pageNumber, text));
    if (response) {
      setResult({ type: "selection", label: `Selected text · page ${pageNumber}`, value: response.explanation });
      setSelectedText("");
      window.getSelection()?.removeAllRanges();
    }
  }

  async function submitQuestion(event) {
    event.preventDefault();
    const value = question.trim();
    if (!value) return;
    const response = await runAction(() => askPaperQuestion(workspaceId, value, answerMode));
    if (response) {
      setResult({ type: "answer", label: response.answer.label, value: response.answer });
      setQuestion("");
    }
  }

  function pointerPosition(event) {
    const rect = pageRef.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top))
    };
  }

  function startCrop(event) {
    if (!figureMode) return;
    event.preventDefault();
    const point = pointerPosition(event);
    setDragStart(point);
    setCrop({ x: point.x, y: point.y, width: 0, height: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveCrop(event) {
    if (!figureMode || !dragStart) return;
    const point = pointerPosition(event);
    setCrop({
      x: Math.min(dragStart.x, point.x),
      y: Math.min(dragStart.y, point.y),
      width: Math.abs(point.x - dragStart.x),
      height: Math.abs(point.y - dragStart.y)
    });
  }

  async function finishCrop(event) {
    if (!figureMode || !dragStart) return;
    const point = pointerPosition(event);
    const selection = {
      x: Math.min(dragStart.x, point.x),
      y: Math.min(dragStart.y, point.y),
      width: Math.abs(point.x - dragStart.x),
      height: Math.abs(point.y - dragStart.y)
    };
    setDragStart(null);
    setCrop(selection);
    if (selection.width < 20 || selection.height < 20) return;
    const source = pageRef.current.querySelector("canvas");
    if (!source) return;
    const sourceRect = source.getBoundingClientRect();
    const wrapperRect = pageRef.current.getBoundingClientRect();
    const left = selection.x + wrapperRect.left - sourceRect.left;
    const top = selection.y + wrapperRect.top - sourceRect.top;
    const scaleX = source.width / sourceRect.width;
    const scaleY = source.height / sourceRect.height;
    const output = document.createElement("canvas");
    output.width = Math.max(1, Math.round(selection.width * scaleX));
    output.height = Math.max(1, Math.round(selection.height * scaleY));
    output.getContext("2d").drawImage(
      source,
      Math.max(0, left * scaleX),
      Math.max(0, top * scaleY),
      output.width,
      output.height,
      0,
      0,
      output.width,
      output.height
    );
    setFigureMode(false);
    const imageDataUrl = output.toDataURL("image/jpeg", 0.88);
    const response = await runAction(() => explainPaperFigure(workspaceId, pageNumber, imageDataUrl));
    if (response) {
      setResult({ type: "figure", label: `Selected figure · page ${pageNumber}`, value: response.explanation });
    }
  }

  async function removePaper() {
    await deletePaperBlob(workspaceId).catch(() => {});
    try {
      await deletePaperWorkspace(workspaceId);
    } finally {
      navigate("/papers");
    }
  }

  if (state === "loading") {
    return <div className="grid min-h-[65vh] place-items-center"><LoaderCircle className="animate-spin text-acid" /></div>;
  }

  if (!workspace || !paperRecord) {
    return (
      <section className="mx-auto max-w-3xl px-5 py-20 sm:px-8">
        <Alert>{error || "The original PDF is missing from this browser. Reselect it to restore this workspace."}</Alert>
        <Button className="mt-6" onClick={() => navigate("/papers")}>Return to paper workspace</Button>
      </section>
    );
  }

  const ready = workspace.document.status === "ready";
  return (
    <section className="mx-auto max-w-[1500px] px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <Link to="/papers" className="flex items-center gap-2 text-sm text-ink/60 hover:text-ink"><ArrowLeft size={16} /> Back to papers</Link>
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink/45">{workspace.aiActionCount}/{workspace.aiActionLimit} AI actions</span>
          <Button size="sm" variant="outline" onClick={removePaper}><Trash2 size={15} className="mr-2" /> Delete</Button>
        </div>
      </div>

      <div className="mb-6 rounded-2xl border border-line bg-cream p-5">
        <Badge>{ready ? "AI white paper" : workspace.document.status}</Badge>
        <h1 className="mt-3 font-serif text-2xl sm:text-3xl">{workspace.document.title}</h1>
        <p className="mt-2 text-sm text-ink/50">{workspace.originalFilename} · {workspace.document.pageCount || "—"} pages</p>
      </div>

      {error && <Alert className="mb-5">{error}</Alert>}
      {!ready && <Alert className="mb-5">The PDF is visible locally while server-side extraction and indexing finish. AI actions will unlock when it is ready.</Alert>}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_430px]">
        <div className="min-w-0 rounded-2xl border border-line bg-[#111A16] p-3 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={pageNumber <= 1} onClick={() => changePage(pageNumber - 1)}><ChevronLeft size={16} /></Button>
              <span className="min-w-24 text-center text-sm">Page {pageNumber} of {numPages || workspace.document.pageCount}</span>
              <Button size="sm" variant="outline" disabled={pageNumber >= (numPages || workspace.document.pageCount)} onClick={() => changePage(pageNumber + 1)}><ChevronRight size={16} /></Button>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => changeZoom(zoom - 0.1)}><ZoomOut size={16} /></Button>
              <span className="text-xs text-ink/50">{Math.round(zoom * 100)}%</span>
              <Button size="sm" variant="outline" onClick={() => changeZoom(zoom + 0.1)}><ZoomIn size={16} /></Button>
              <Button size="sm" variant={figureMode ? "default" : "outline"} disabled={!ready} onClick={() => { setFigureMode((value) => !value); setCrop(null); }}><Crop size={15} className="mr-2" /> Select figure</Button>
            </div>
          </div>

          <div className="overflow-auto rounded-xl bg-white p-2">
            <div
              ref={pageRef}
              className={`relative mx-auto w-fit ${figureMode ? "cursor-crosshair select-none" : ""}`}
              onMouseUp={() => {
                if (figureMode) return;
                const text = window.getSelection()?.toString().trim() || "";
                setSelectedText(text.slice(0, 8000));
              }}
              onPointerDown={startCrop}
              onPointerMove={moveCrop}
              onPointerUp={finishCrop}
            >
              <Document
                file={paperRecord.pdfBlob}
                onLoadSuccess={({ numPages: count }) => {
                  setNumPages(count);
                  setError("");
                }}
                onLoadError={(loadError) => {
                  console.error("PDF viewer failed to load the browser Blob", loadError);
                  setError("The PDF viewer could not open the browser copy. Return to papers and reselect the original PDF.");
                }}
                loading={<div className="grid h-[70vh] w-[500px] place-items-center text-black"><LoaderCircle className="animate-spin" /></div>}
                error={<div className="grid min-h-48 place-items-center px-6 text-center text-sm text-red-700">The PDF could not be displayed.</div>}
              >
                <Page pageNumber={pageNumber} scale={zoom} renderAnnotationLayer renderTextLayer />
              </Document>
              {figureMode && <div className="pointer-events-none absolute inset-0 bg-black/10" />}
              {crop && <div className="pointer-events-none absolute border-2 border-acid bg-acid/10" style={{ left: crop.x, top: crop.y, width: crop.width, height: crop.height }} />}
            </div>
          </div>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-5">
          {selectedText && ready && (
            <div className="rounded-2xl border border-acid/40 bg-elevated p-5">
              <p className="line-clamp-4 text-sm leading-6 text-ink/70">“{selectedText}”</p>
              <Button className="mt-4 w-full" disabled={state === "answering"} onClick={explainSelection}>Explain selected text</Button>
            </div>
          )}

          <form className="rounded-2xl border border-line bg-cream p-5" onSubmit={submitQuestion}>
            <h2 className="font-serif text-xl">Ask this paper</h2>
            <p className="mt-2 text-sm leading-6 text-ink/50">Choose whether the answer should start with paper evidence or use Gemini's general AI knowledge.</p>
            <div className="mt-4 rounded-xl border border-line bg-elevated/50 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className={`text-sm font-semibold ${answerMode === "paper" ? "text-ink" : "text-ink/45"}`}>Paper first</span>
                <Switch
                  checked={answerMode === "general"}
                  onCheckedChange={(checked) => setAnswerMode(checked ? "general" : "paper")}
                  disabled={!ready || state === "answering"}
                  aria-label="Use general knowledge instead of paper retrieval"
                />
                <span className={`text-sm font-semibold ${answerMode === "general" ? "text-ink" : "text-ink/45"}`}>General knowledge</span>
              </div>
              <p className="mt-2 text-xs leading-5 text-ink/50">
                {answerMode === "paper"
                  ? "Retrieves from this paper first. If its evidence is insufficient, the answer falls back to general knowledge and says so clearly."
                  : "Skips paper retrieval and answers directly from general AI knowledge."}
              </p>
            </div>
            <Textarea className="mt-4 min-h-28" placeholder="Ask an AI-related question…" value={question} onChange={(event) => setQuestion(event.target.value)} disabled={!ready || state === "answering"} />
            <Button className="mt-3 w-full" disabled={!ready || state === "answering" || !question.trim()}>
              {state === "answering" ? <LoaderCircle size={16} className="mr-2 animate-spin" /> : <Send size={16} className="mr-2" />} Ask
            </Button>
          </form>

          <ResultCard result={result} />
        </aside>
      </div>
    </section>
  );
}
