import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronDown } from "lucide-react";

export const Accordion = AccordionPrimitive.Root;

export function AccordionItem({ className = "", ...props }) {
  return <AccordionPrimitive.Item className={`border-b border-line ${className}`} {...props} />;
}

export function AccordionTrigger({ className = "", children, ...props }) {
  return (
    <AccordionPrimitive.Header>
      <AccordionPrimitive.Trigger
        className={`group flex w-full items-center justify-between py-4 text-left text-sm font-semibold ${className}`}
        {...props}
      >
        {children}
        <ChevronDown className="size-4 transition group-data-[state=open]:rotate-180" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export function AccordionContent({ className = "", children, ...props }) {
  return (
    <AccordionPrimitive.Content className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down" {...props}>
      <div className={`pb-5 text-sm leading-7 text-ink/70 ${className}`}>{children}</div>
    </AccordionPrimitive.Content>
  );
}
