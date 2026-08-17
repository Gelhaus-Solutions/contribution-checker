/**
 * Shared page shell widths.
 *
 * Every page used to pick its own `max-w-*`, which produced three unrelated
 * tiers and left the dashboard as a 1152px strip with ~384px of empty margin
 * on each side of a 1920px screen. These are the only three widths, chosen by
 * what the page contains rather than by habit.
 */

/**
 * Data-dense surfaces: the dashboard, the project shell, list and table views.
 * Effectively full width, with a cap so an ultrawide monitor does not stretch
 * a table to 3000px.
 */
export const SHELL = "mx-auto w-full max-w-[110rem] px-5 sm:px-8 lg:px-12";

/**
 * Utility pages that are mostly one column of cards: admin index, allowlist,
 * vault, templates, notifications. Wide enough not to strand the page, narrow
 * enough that a settings form is not a single 1700px row.
 */
export const SHELL_MEDIUM = "mx-auto w-full max-w-5xl px-5 sm:px-8";

/**
 * Reading and form surfaces: the public application flow, CLA signing, the
 * setup walkthrough, project creation. These stay narrow on purpose; a form
 * field or a paragraph gains nothing from more width.
 */
export const SHELL_NARROW = "mx-auto w-full max-w-3xl px-5";
