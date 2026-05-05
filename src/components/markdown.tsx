import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { cn } from "@/lib/cn";

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), ["target"], ["rel"]],
    code: [...(defaultSchema.attributes?.code ?? []), ["className"]],
  },
};

export function Markdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  return (
    <div className={cn("text-sm leading-relaxed break-words", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
        components={{
          a: ({ node: _n, ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-2 hover:underline"
            />
          ),
          p: ({ node: _n, ...props }) => (
            <p {...props} className="my-1 first:mt-0 last:mb-0" />
          ),
          ul: ({ node: _n, ...props }) => (
            <ul {...props} className="my-1 list-disc pl-5" />
          ),
          ol: ({ node: _n, ...props }) => (
            <ol {...props} className="my-1 list-decimal pl-5" />
          ),
          li: ({ node: _n, ...props }) => <li {...props} className="my-0.5" />,
          h1: ({ node: _n, ...props }) => (
            <h3 {...props} className="my-2 text-base font-semibold" />
          ),
          h2: ({ node: _n, ...props }) => (
            <h3 {...props} className="my-2 text-base font-semibold" />
          ),
          h3: ({ node: _n, ...props }) => (
            <h4 {...props} className="my-2 text-sm font-semibold" />
          ),
          h4: ({ node: _n, ...props }) => (
            <h5 {...props} className="my-1 text-sm font-semibold" />
          ),
          h5: ({ node: _n, ...props }) => (
            <h6 {...props} className="my-1 text-sm font-semibold" />
          ),
          h6: ({ node: _n, ...props }) => (
            <h6 {...props} className="my-1 text-sm font-semibold" />
          ),
          code: ({ node: _n, className: cls, children, ...props }) => {
            const isBlock = /language-/.test(cls ?? "");
            if (isBlock) {
              return (
                <code
                  {...props}
                  className={cn(
                    "block whitespace-pre-wrap break-words font-mono text-xs",
                    cls,
                  )}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                {...props}
                className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
              >
                {children}
              </code>
            );
          },
          pre: ({ node: _n, ...props }) => (
            <pre
              {...props}
              className="my-2 overflow-x-auto rounded-md border border-border bg-muted p-3 text-xs"
            />
          ),
          blockquote: ({ node: _n, ...props }) => (
            <blockquote
              {...props}
              className="my-2 border-l-2 border-border pl-3 text-muted-foreground"
            />
          ),
          hr: ({ node: _n, ...props }) => (
            <hr {...props} className="my-3 border-border" />
          ),
          table: ({ node: _n, ...props }) => (
            <div className="my-2 overflow-x-auto">
              <table {...props} className="w-full border-collapse text-xs" />
            </div>
          ),
          th: ({ node: _n, ...props }) => (
            <th
              {...props}
              className="border border-border bg-muted/40 px-2 py-1 text-left font-semibold"
            />
          ),
          td: ({ node: _n, ...props }) => (
            <td {...props} className="border border-border px-2 py-1" />
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
