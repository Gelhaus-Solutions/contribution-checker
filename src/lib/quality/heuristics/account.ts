import type { Heuristic } from "@/lib/quality/types";

const asNumber = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const SPAM_USERNAME_RE =
  /^(?:[a-z]?\d{4,}|.*?(?:ai|gpt|bot|copilot)\d*|user\d{3,}|test\d+)$/i;

export const accountHeuristics: Heuristic[] = [
  {
    id: "account.spam_username",
    group: "account",
    label: "Spam-like username",
    description:
      "Username matches common spam/AI patterns (digit-heavy, ai/gpt/bot suffix, etc.).",
    weight: 2,
    defaultEnabled: true,
    run(ctx) {
      const login = ctx.account.login ?? ctx.pr.authorLogin ?? "";
      return {
        failed: SPAM_USERNAME_RE.test(login),
        value: login,
      };
    },
  },
  {
    id: "account.too_new",
    group: "account",
    label: "Account too new",
    description: "GitHub account created less than the configured number of days ago.",
    weight: 2,
    defaultEnabled: true,
    defaultThreshold: 30,
    thresholdKind: "number",
    run(ctx, threshold) {
      const days = asNumber(threshold, 30);
      if (!ctx.account.createdAt) return { failed: false };
      const ageMs = Date.now() - new Date(ctx.account.createdAt).getTime();
      const ageDays = ageMs / 86_400_000;
      return {
        failed: ageDays < days,
        value: Math.floor(ageDays),
        reason: ageDays < days ? `${Math.floor(ageDays)} days old` : undefined,
      };
    },
  },
  {
    id: "account.mass_forking",
    group: "account",
    label: "Mass forking",
    description:
      "Author has created an unusually large number of forks in the last 24 hours.",
    weight: 3,
    defaultEnabled: false,
    defaultThreshold: 6,
    thresholdKind: "number",
    run(ctx, threshold) {
      const max = asNumber(threshold, 6);
      const n = ctx.account.recentForkCount;
      if (typeof n !== "number") return { failed: false };
      return {
        failed: n > max,
        value: n,
        reason: n > max ? `${n} forks (>${max})` : undefined,
      };
    },
  },
  {
    id: "account.low_merge_ratio",
    group: "account",
    label: "Low global merge ratio",
    description:
      "Author's global merged-PR / total-PR ratio is below the configured percent.",
    weight: 2,
    defaultEnabled: false,
    defaultThreshold: 30,
    thresholdKind: "number",
    run(ctx, threshold) {
      const minPct = asNumber(threshold, 30);
      const total = ctx.account.totalPrCount;
      const merged = ctx.account.mergedPrCount;
      if (typeof total !== "number" || total === 0 || typeof merged !== "number")
        return { failed: false };
      const pct = (merged / total) * 100;
      return {
        failed: pct < minPct,
        value: Math.round(pct),
        reason: pct < minPct ? `${Math.round(pct)}% (<${minPct}%)` : undefined,
      };
    },
  },
  {
    id: "account.profile_thin",
    group: "account",
    label: "Thin profile",
    description:
      "Empty bio AND no avatar AND <2 followers AND <1 public repo. Often a throwaway account.",
    weight: 2,
    defaultEnabled: true,
    run(ctx) {
      const a = ctx.account;
      const failed =
        !(a.bio ?? "").trim() &&
        !a.hasAvatar &&
        (a.followers ?? 0) < 2 &&
        (a.publicRepos ?? 0) < 1;
      return { failed };
    },
  },
  {
    id: "account.no_email",
    group: "account",
    label: "No public email",
    description: "Profile exposes no public email address.",
    weight: 1,
    defaultEnabled: false,
    run(ctx) {
      const failed = !ctx.account.email;
      return { failed, penaltyPoints: failed ? 5 : 0 };
    },
  },
];
