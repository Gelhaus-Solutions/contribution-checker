import Link from "next/link";
import { Alert } from "@/components/ui/alert";

/**
 * Shown in place of a CLA page's content while GPlatform Legal, which holds a
 * moved project's CLA records (GPLATLEGAL-61), cannot answer. Maintainers
 * learn what still works; contributors learn that a signature is not lost.
 */
export function LegalUnavailable({
  audience,
  project,
  retryHref,
}: {
  audience: "maintainer" | "contributor";
  /** The project's name, for contributors. */
  project?: string;
  retryHref: string;
}) {
  if (audience === "maintainer") {
    return (
      <Alert variant="warning" title="GPlatform Legal is not answering">
        <p>
          This project&apos;s CLA records (its texts, signatures, companies and
          their chain) are kept in GPlatform Legal, which could not be reached
          just now. Nothing is lost. Until it answers, nothing here can be
          changed, and pull request checks use the last answer they had for each
          contributor; the others wait.
        </p>
        <p>
          <Link href={retryHref}>Try again</Link>
        </p>
      </Alert>
    );
  }
  return (
    <Alert variant="warning" title="The CLA cannot be shown right now">
      <p>
        {project ? `${project}'s` : "This project's"} contributor agreements are
        kept in GPlatform Legal, which is not answering just now. If you have
        signed, your signature is safe. Please try again in a few minutes.
      </p>
      <p>
        <Link href={retryHref}>Try again</Link>
      </p>
    </Alert>
  );
}
