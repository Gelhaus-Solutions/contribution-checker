import { cn } from "@/lib/cn";

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      <rect
        x="1.5"
        y="1.5"
        width="29"
        height="29"
        rx="8"
        className="fill-primary/10 stroke-primary/40"
        strokeWidth="1.25"
      />
      <path
        d="M10 16.5l4 4 8-9"
        className="stroke-primary"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx="22.5"
        cy="9"
        r="2.25"
        className="fill-primary"
      />
    </svg>
  );
}
