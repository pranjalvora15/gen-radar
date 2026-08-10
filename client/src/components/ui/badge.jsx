export function Badge({ className = "", variant = "default", ...props }) {
  const styles =
    variant === "outline"
      ? "border border-line bg-transparent text-ink/70"
      : "border border-transparent bg-acid text-[#0E1512]";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none ${styles} ${className}`}
      {...props}
    />
  );
}
