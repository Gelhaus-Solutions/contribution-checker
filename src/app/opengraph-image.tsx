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
          <svg width="64" height="64" viewBox="0 0 32 32" fill="none">
            <rect
              x="1.5"
              y="1.5"
              width="29"
              height="29"
              rx="8"
              fill={BRAND}
              fillOpacity="0.14"
              stroke={BRAND}
              strokeOpacity="0.45"
              strokeWidth="1.25"
            />
            <path
              d="M10 16.5l4 4 8-9"
              stroke={BRAND}
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="22.5" cy="9" r="2.25" fill={BRAND} />
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
