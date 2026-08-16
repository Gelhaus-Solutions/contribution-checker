"use client";

import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

type Mode = "typed" | "drawn" | "uploaded";

const MAX_IMAGE_BYTES = 2_000_000;

/**
 * Signature capture supporting three legally-recognized methods: type a name,
 * draw on a pad, or upload an image of a wet signature. Emits three hidden
 * inputs (prefixed so it can be embedded alongside another form):
 *   ${prefix}signatureKind  = "typed" | "drawn" | "uploaded"
 *   ${prefix}signatureText  = the typed signature (when typed)
 *   ${prefix}signatureImage = a data URL (when drawn/uploaded)
 * The server validates and stores these immutably on the signature record.
 */
export function SignatureInput({
  fieldPrefix = "",
  required = false,
}: {
  fieldPrefix?: string;
  required?: boolean;
}) {
  const [mode, setMode] = useState<Mode>("typed");
  const [typed, setTyped] = useState("");
  const [image, setImage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  const name = (s: string) => `${fieldPrefix}${s}`;

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    // Scale CSS coordinates to the canvas's internal pixel resolution so the
    // stroke tracks the pointer even when the canvas is responsively resized.
    return {
      x: (e.clientX - r.left) * (c.width / r.width),
      y: (e.clientY - r.top) * (c.height / r.height),
    };
  }
  function startDraw(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }
  function moveDraw(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    dirty.current = true;
  }
  function endDraw() {
    if (!drawing.current) return;
    drawing.current = false;
    if (dirty.current && canvasRef.current) {
      setImage(canvasRef.current.toDataURL("image/png"));
    }
  }
  function clearCanvas() {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (c && ctx) ctx.clearRect(0, 0, c.width, c.height);
    dirty.current = false;
    setImage("");
  }

  function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      setError("Please upload an image file.");
      return;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      setError("Image must be under 2 MB.");
      return;
    }
    setError(null);
    const reader = new FileReader();
    reader.onload = () => setImage(String(reader.result));
    reader.readAsDataURL(f);
  }

  const tabs: { m: Mode; label: string }[] = [
    { m: "typed", label: "Type" },
    { m: "drawn", label: "Draw" },
    { m: "uploaded", label: "Upload" },
  ];

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {tabs.map(({ m, label }) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setError(null);
            }}
            className={
              mode === m
                ? "rounded-md bg-muted px-2.5 py-1 text-xs font-medium"
                : "rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/50"
            }
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "typed" && (
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          required={required}
          minLength={2}
          maxLength={200}
          autoComplete="name"
          placeholder="Type your full legal name to sign"
          className="font-[cursive] text-base"
        />
      )}

      {mode === "drawn" && (
        <div className="space-y-1">
          <canvas
            ref={canvasRef}
            width={500}
            height={160}
            onPointerDown={startDraw}
            onPointerMove={moveDraw}
            onPointerUp={endDraw}
            onPointerLeave={endDraw}
            className="h-40 w-full touch-none rounded-md border border-border bg-background"
          />
          <Button type="button" size="sm" variant="ghost" onClick={clearCanvas}>
            Clear
          </Button>
        </div>
      )}

      {mode === "uploaded" && (
        <div className="space-y-1">
          <input
            type="file"
            accept="image/*"
            onChange={onUpload}
            className="text-sm"
          />
          {image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt="Signature preview"
              className="max-h-24 rounded-md border border-border bg-background p-1"
            />
          )}
        </div>
      )}

      {error && <Alert variant="destructive">{error}</Alert>}

      <input type="hidden" name={name("signatureKind")} value={mode} />
      <input
        type="hidden"
        name={name("signatureText")}
        value={mode === "typed" ? typed : ""}
      />
      <input
        type="hidden"
        name={name("signatureImage")}
        value={mode === "typed" ? "" : image}
      />
    </div>
  );
}
