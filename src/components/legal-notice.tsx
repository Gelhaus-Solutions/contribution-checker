import { env } from "@/lib/env";

type LegalLink = { href: string; label: string };

/** The operator's legal documents, from LEGAL_*_URL. Empty when none is set. */
export function legalLinks(): LegalLink[] {
  return [
    env.LEGAL_PRIVACY_URL && { href: env.LEGAL_PRIVACY_URL, label: "Privacy" },
    env.LEGAL_TERMS_URL && { href: env.LEGAL_TERMS_URL, label: "Terms" },
    env.LEGAL_IMPRINT_URL && { href: env.LEGAL_IMPRINT_URL, label: "Imprint" },
  ].filter((l): l is LegalLink => !!l);
}

/**
 * The notice shown where personal data is collected (GDPR Art. 13): the
 * application form and the CLA signing page. Server component, so the URLs are
 * read at request time like the rest of the runtime config.
 */
export function CollectionNotice({ what }: { what: string }) {
  const privacy = env.LEGAL_PRIVACY_URL;
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      {what} will be stored by the operator of this instance for this project.
      {privacy ? (
        <>
          {" "}
          What is stored, who receives it, how long it is kept and your rights are
          set out in the{" "}
          <a href={privacy} className="underline underline-offset-2">
            privacy notice
          </a>
          .
        </>
      ) : null}
    </p>
  );
}
