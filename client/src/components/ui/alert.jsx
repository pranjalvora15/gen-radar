export function Alert({ className = "", children }) {
  return (
    <div role="alert" className={`rounded-2xl border border-amber-500/40 bg-amber-950/30 p-4 text-sm text-amber-100 ${className}`}>
      {children}
    </div>
  );
}
