export function Button({ className = "", variant = "default", size = "default", ...props }) {
  const variantStyles = {
    default: "bg-acid text-[#0E1512] hover:bg-moss",
    outline: "border border-line bg-cream text-ink hover:border-moss/70 hover:bg-elevated",
    ghost: "bg-transparent text-ink hover:bg-ink/10"
  };
  const sizeStyles = {
    default: "h-11 px-5",
    sm: "h-9 px-3",
    lg: "h-12 px-6"
  };
  return (
    <button
      className={`inline-flex items-center justify-center rounded-full text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss disabled:pointer-events-none disabled:opacity-50 ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
      {...props}
    />
  );
}
