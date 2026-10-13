import { NextResponse } from "next/server";
import { presentsDecoyKey } from "@/lib/lockdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every /api path no route answers. Whoever found the decoy API key tries it
 * against endpoints they guess far more often than against the few real ones,
 * so a honeytoken only the real routes checked would miss the likeliest use
 * (GLockdown L97, src/lib/lockdown.ts). GLockdown is told; the answer is the
 * same 404 every unknown path gets, key or no key.
 */
function notFound(req: Request): NextResponse {
  presentsDecoyKey(req);
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

export const GET = notFound;
export const HEAD = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
