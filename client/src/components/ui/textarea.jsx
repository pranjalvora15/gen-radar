export function Textarea({ className = "", ...props }) {
  return (
    <textarea
      className={`min-h-24 w-full resize-none rounded-2xl border border-line bg-[#0E1512] px-4 py-3 text-sm leading-6 text-ink outline-none transition placeholder:text-ink/35 focus:border-moss focus:ring-2 focus:ring-moss/20 ${className}`}
      {...props}
    />
  );
}
