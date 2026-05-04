import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { computeScore } from "@/lib/quality/score";
import { parseQualityConfig, ALL_HEURISTICS } from "@/lib/quality/registry";
import type { SignalsRaw } from "@/lib/quality/types";
import { PrsList, type PrRow, type RepoOption } from "./prs-list";

type SearchParams = {
  author?: string;
  prNumber?: string;
  status?: string;
  repo?: string;
  closedByApp?: string;
  minScore?: string;
  maxScore?: string;
};

const STATUS_VALUES = ["PENDING", "APPROVED", "DENIED", "BYPASSED"] as const;

export default async function ProjectPRs({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  await requireProjectRole(id, "ADMIN");

  const project = await prisma.project.findUnique({
    where: { id },
    select: { qualityEnabled: true, qualityConfig: true },
  });
  if (!project) throw new Error("Project not found");

  const config = parseQualityConfig(project.qualityConfig);

  const [repos, prChecks] = await Promise.all([
    prisma.repo.findMany({
      where: { projectId: id },
      select: { id: true, fullName: true },
      orderBy: { fullName: "asc" },
    }),
    prisma.prCheck.findMany({
      where: { repo: { projectId: id } },
      include: {
        repo: { select: { id: true, fullName: true } },
        quality: project.qualityEnabled,
      },
      orderBy: { updatedAt: "desc" },
      take: 1000,
    }),
  ]);

  const rows: PrRow[] = prChecks.map((c) => {
    let quality: PrRow["quality"] = null;
    if (project.qualityEnabled && c.quality) {
      const signals = JSON.parse(c.quality.signalsRaw) as SignalsRaw;
      const summary = computeScore(signals, config);
      const failed = summary.failedIds.map((hid) => {
        const h = ALL_HEURISTICS.find((x) => x.id === hid);
        const sig = signals[hid];
        return { id: hid, label: h?.label ?? hid, reason: sig?.reason };
      });
      quality = { score: summary.score, failed };
    }
    return {
      id: c.id,
      repoId: c.repo.id,
      repoFullName: c.repo.fullName,
      prNumber: c.prNumber,
      authorGhLogin: c.authorGhLogin,
      status: c.status as PrRow["status"],
      closedByApp: c.closedByApp,
      updatedAt: c.updatedAt.toISOString(),
      quality,
    };
  });

  const repoOptions: RepoOption[] = repos.map((r) => ({
    id: r.id,
    fullName: r.fullName,
  }));

  const initialFilters = {
    author: sp.author ?? "",
    prNumber: (sp.prNumber ?? "").replace(/[^0-9]/g, ""),
    status: STATUS_VALUES.includes(sp.status as (typeof STATUS_VALUES)[number])
      ? (sp.status as (typeof STATUS_VALUES)[number])
      : ("ALL" as const),
    repoId: sp.repo && repoOptions.some((r) => r.id === sp.repo) ? sp.repo : "ALL",
    closedByApp:
      sp.closedByApp === "1" ? true : sp.closedByApp === "0" ? false : null,
    minScore: clampScoreParam(sp.minScore),
    maxScore: clampScoreParam(sp.maxScore),
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pull requests</CardTitle>
        <CardDescription>
          Every PR this project has evaluated. Filter by author, status, repo,
          or quality score.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <PrsList
          projectId={id}
          rows={rows}
          repos={repoOptions}
          qualityEnabled={project.qualityEnabled}
          initialFilters={initialFilters}
        />
      </CardContent>
    </Card>
  );
}

function clampScoreParam(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}
