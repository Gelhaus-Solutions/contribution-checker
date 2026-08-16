import { test, expect, type Page } from "@playwright/test";

/**
 * Public routes only. Everything behind auth needs a Hexclave session, which
 * this suite deliberately does not try to fake.
 */
const PUBLIC_ROUTES = [
  { path: "/", heading: /gate you control/i },
  { path: "/how-it-works", heading: /the gating pipeline/i },
  { path: "/quality", heading: /pr quality score/i },
  { path: "/for-contributors", heading: /closed automatically/i },
];

/** Fail on console errors, which is how a broken client boundary shows up. */
function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme });

    for (const route of PUBLIC_ROUTES) {
      test(`${route.path} renders`, async ({ page, context }) => {
        await context.addCookies([
          {
            name: "cc-theme",
            value: theme,
            url: "http://127.0.0.1:3100",
          },
        ]);
        const errors = trackConsoleErrors(page);
        const res = await page.goto(route.path);

        expect(res?.status()).toBe(200);
        await expect(
          page.getByRole("heading", { level: 1, name: route.heading }),
        ).toBeVisible();

        // The dark class must actually be on <html>, otherwise the palette
        // silently falls back to light and nothing else would notice.
        const isDark = await page.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        );
        expect(isDark).toBe(theme === "dark");

        // The page must never scroll sideways.
        const overflows = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        );
        expect(overflows, "page scrolls horizontally").toBe(false);

        expect(errors).toEqual([]);
      });
    }
  });
}

test("a bad URL renders the styled 404, not Next's default", async ({
  page,
}) => {
  const res = await page.goto("/definitely-not-a-real-page");
  expect(res?.status()).toBe(404);
  await expect(page.getByText(/that page does not exist/i)).toBeVisible();
});

test("the quality catalogue is generated from the registry", async ({
  page,
}) => {
  await page.goto("/quality");
  // A real heuristic id, so a retyped catalogue would fail this.
  await expect(page.getByText("pr.title_vague").first()).toBeVisible();
});
