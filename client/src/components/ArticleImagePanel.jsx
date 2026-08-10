import { Image as ImageIcon, LoaderCircle } from "lucide-react";
import { Badge } from "./ui/badge";

export default function ArticleImagePanel({
  images,
  selectedMediaId,
  onSelect,
  canAsk,
  mediaStatus,
  error
}) {
  const isDiscovering = ["pending", "processing"].includes(mediaStatus);
  if (images.length === 0 && !isDiscovering && !error) return null;

  const selected = images.find(
    (image) => image.id === selectedMediaId
  ) || null;
  const imageNumber = (image) => image.sourceOrder;

  return (
    <aside className="order-1 rounded-3xl border border-line bg-elevated p-4 lg:sticky lg:top-6 lg:order-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ImageIcon size={17} className="text-acid" />
          <h2 className="font-serif text-lg">Article images</h2>
        </div>
        <Badge variant="outline">
          {images.length > 0 ? `${images.length} images` : "Scanning"}
        </Badge>
      </div>
      <p className="mt-2 text-xs leading-5 text-ink/45">
        {isDiscovering
          ? "Finding article images. Available images can be selected now."
          : canAsk
          ? "Select an image, then ask about it. AI analyzes it with your question."
          : "Images referenced by this public conversation."}
      </p>

      {isDiscovering && (
        <p className="mt-3 flex items-center gap-2 text-xs font-semibold text-acid">
          <LoaderCircle size={13} className="animate-spin" />
          Discovering more images without blocking the chat
        </p>
      )}

      {error && (
        <p className="mt-3 text-xs leading-5 text-red-300">{error}</p>
      )}

      {selected && (
        <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-[#0E1512]">
          <a href={selected.sourceUrl} target="_blank" rel="noreferrer">
            <img
              src={selected.previewUrl || selected.sourceUrl}
              alt={selected.analysis?.description || `Selected article image ${imageNumber(selected)}`}
              className="h-48 w-full object-contain"
            />
          </a>
          <div className="p-3">
            <p className="text-xs font-bold text-acid">
              Image {imageNumber(selected)}
            </p>
            {selected.analysis?.description && (
              <p className="mt-1 line-clamp-3 text-xs leading-5 text-ink/50">
                {selected.analysis.description}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="mt-4 grid grid-cols-4 gap-2 lg:grid-cols-2">
        {images.map((image) => {
          const active = image.id === selectedMediaId;
          const number = imageNumber(image);
          return (
            <button
              key={image.id}
              type="button"
              onClick={() => onSelect(active ? null : image.id)}
              disabled={!canAsk}
              className={`overflow-hidden rounded-xl border text-left transition ${
                active
                  ? "border-acid ring-2 ring-acid/20"
                  : "border-line hover:border-ink/35"
              } disabled:cursor-default disabled:hover:border-line`}
              aria-pressed={active}
              aria-label={`Select image ${number}`}
            >
              <img
                src={image.previewUrl || image.sourceUrl}
                alt={image.analysis?.description || `Article image ${number}`}
                className="h-20 w-full bg-[#0E1512] object-cover"
                loading="lazy"
              />
              <span className="block px-2 py-1.5 text-[11px] font-semibold">
                Image {number}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
