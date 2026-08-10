import * as SwitchPrimitive from "@radix-ui/react-switch";

export function Switch({ className = "", ...props }) {
  return (
    <SwitchPrimitive.Root
      className={`group inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-line bg-elevated px-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-acid ${className}`}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-5 rounded-full bg-ink shadow-sm transition-transform data-[state=checked]:translate-x-5 data-[state=checked]:bg-[#0E1512]" />
    </SwitchPrimitive.Root>
  );
}
