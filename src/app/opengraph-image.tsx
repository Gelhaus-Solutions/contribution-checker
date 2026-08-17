import { ImageResponse } from "next/og";

export const alt =
  "contribution-checker: gate pull requests behind a contributor application";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Node runtime, not edge: this codebase pulls in Prisma and pino elsewhere, and
// there is no reason to split runtimes for one image. Cached for a day so
// crawlers do not regenerate it on every fetch.
export const runtime = "nodejs";
export const revalidate = 86400;

const BG = "#0e1218";
const FG = "#eaeef5";
const MUTED = "#8b93a3";
const BRAND = "#1d81f3";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: BG,
          padding: 72,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {/* Matches components/brand-mark.tsx. Satori has no mask support, so
              the cuts are painted in the background color instead. */}
          <svg width="64" height="64" viewBox="0 0 32 32">
            <rect width="32" height="32" rx="9" fill={BRAND} />
            <path
              d="M9.25 16.5l4.5 4.5L21.25 12.5"
              fill="none"
              stroke={BG}
              strokeWidth="3.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="25.25" cy="6.75" r="3.5" fill={BG} />
            <circle cx="25.25" cy="6.75" r="1.9" fill={BRAND} />
          </svg>
          <span style={{ fontSize: 34, color: MUTED }}>
            contribution<span style={{ color: BRAND }}>/</span>checker
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              fontSize: 68,
              color: FG,
              lineHeight: 1.1,
              letterSpacing: "-0.03em",
              maxWidth: 900,
            }}
          >
            Every pull request goes through a gate you control.
          </div>
          <div style={{ height: 1, background: "#2a3240", width: "100%" }} />
          <div style={{ fontSize: 28, color: MUTED }}>
            Self-hosted GitHub App. Application gating, CLA, DCO, and
            deterministic PR scoring.
          </div>
        </div>
      </div>
    ),
    size,
  );
}
