export function Input({ className = "", ...props }) {
  return (
    <input
      className={`h-12 w-full rounded-full border border-line bg-[#0E1512] px-5 text-sm text-ink outline-none transition placeholder:text-ink/35 focus:border-moss focus:ring-2 focus:ring-moss/20 ${className}`}
      {...props}
    />
  );
}
