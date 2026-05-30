export type DcoCommit = { sha: string; message: string };
export type DcoResult = { ok: boolean; missing: { sha: string; reason: string }[] };

/**
 * A commit satisfies the DCO when its message contains a trailer line of the
 * form `Signed-off-by: Some Name <email@example.com>`. The match is anchored
 * to a line (multiline) and requires a non-empty name and angle-bracketed
 * address. Pure: no I/O, no Octokit.
 */
const SIGNED_OFF_BY = /^Signed-off-by: .+ <[^>]+>$/m;

const MISSING_REASON = "missing Signed-off-by trailer";

/**
 * Verify that every commit carries a valid `Signed-off-by:` trailer.
 *
 * Returns `ok: true` only when all commits pass. `missing` lists the failing
 * commits (in input order) so callers can surface which SHAs need a sign-off.
 *
 * Commit messages may use LF or CRLF line endings; CRLF is normalized before
 * matching so a trailer at the end of a `\r\n`-delimited message still passes.
 */
export function verifyDco(commits: DcoCommit[]): DcoResult {
  const missing: { sha: string; reason: string }[] = [];

  for (const commit of commits) {
    if (!hasSignOff(commit.message)) {
      missing.push({ sha: commit.sha, reason: MISSING_REASON });
    }
  }

  return { ok: missing.length === 0, missing };
}

function hasSignOff(message: string): boolean {
  // Normalize CRLF -> LF so the line-anchored regex matches trailers regardless
  // of the platform that authored the commit. Trim trailing whitespace per line
  // is unnecessary because `$` matches before a `\n`; the trailing `>` anchor
  // already rejects lines with extra content after the address.
  const normalized = message.replace(/\r\n/g, "\n");
  return SIGNED_OFF_BY.test(normalized);
}

/**
 * Contributor-facing guidance for adding a DCO sign-off. Pure string, safe to
 * embed in PR comments / Check summaries.
 */
export const DCO_SIGN_OFF_GUIDANCE = [
  "This project requires a Developer Certificate of Origin (DCO) sign-off on every commit.",
  "",
  "Add a `Signed-off-by` trailer to each commit by committing with the `-s` flag:",
  "",
  "    git commit -s -m \"Your commit message\"",
  "",
  "To sign off commits you have already made, amend or rebase them:",
  "",
  "    git commit --amend -s        # most recent commit",
  "    git rebase --signoff HEAD~N  # the last N commits",
  "",
  "Then force-push the branch. The trailer must read exactly:",
  "",
  "    Signed-off-by: Your Name <your.email@example.com>",
].join("\n");
