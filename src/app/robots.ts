import type { MetadataRoute } from "next";
import { env } from "@/lib/env";

// Rendered per request, not prerendered. The image is built generic with no
// env, so a static render would bake the PUBLIC_BASE_URL fallback
// (http://localhost:3000) into every deployment. Same reasoning as
// generateMetadata in the root layout.
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Authenticated surfaces and machine endpoints. /p is deliberately not
      // listed: whether project pages should be indexed is per-instance, and
      // an operator who wants them private can front them with auth.
      disallow: ["/dashboard", "/admin", "/api", "/handler", "/welcome", "/restricted"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
