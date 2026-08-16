import type { MetadataRoute } from "next";
import { env } from "@/lib/env";

/**
 * The four public explainer routes only. Project pages under /p are
 * per-instance content and are not enumerated here.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  return [
    { url: `${base}/`, priority: 1 },
    { url: `${base}/how-it-works`, priority: 0.8 },
    { url: `${base}/quality`, priority: 0.7 },
    { url: `${base}/for-contributors`, priority: 0.7 },
  ];
}
