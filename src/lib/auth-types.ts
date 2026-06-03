/**
 * Local session shape. Previously this came from the `next-auth` module
 * augmentation in src/auth.ts; after the Hexclave migration the `auth()` shim
 * returns this exact shape so the ~46 downstream consumers (which read
 * `session.user.{id,ghId,ghLogin,isSuperAdmin,canCreateProj,...}`) are unchanged.
 */
export type SessionUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  ghLogin?: string | null;
  ghId?: number | null;
  /** ISO 3166-1 alpha-2, set during onboarding. Null until the user completes
   * the welcome interstitial. */
  country?: string | null;
  isSuperAdmin: boolean;
  canCreateProj: boolean;
  /** True only when the user is restricted BY AN ADMINISTRATOR in Stack Auth.
   * When set, all protected surfaces/actions must route to /restricted. */
  restricted?: boolean;
  /** The admin's public reason string (from `restrictedByAdminReason`), shown on
   * /restricted. NOTE: this is the human-readable text, not the SDK's
   * `restrictedReason: { type }` discriminator. May be null even when restricted. */
  restrictionReason?: string | null;
};

export type Session = {
  user: SessionUser;
};
