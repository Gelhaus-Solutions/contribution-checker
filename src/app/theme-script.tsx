// Server Component. Emits a synchronous inline <script> in <head> that runs
// before first paint, same mechanism as RuntimeEnvScript (the CSP already
// allows 'unsafe-inline' for script-src, see src/lib/security/csp.ts).
//
// Its only job is resolving the "system" theme, which the server cannot know.
// When the cookie pins light or dark the root layout has already stamped the
// class server-side, so this is a no-op and there is no flash in any of the
// three states.

export const THEME_COOKIE = "cc-theme";

export type Theme = "light" | "dark" | "system";

export function isTheme(v: string | undefined): v is Theme {
  return v === "light" || v === "dark" || v === "system";
}

const SCRIPT = `(function(){try{
var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]*)/);
var t=m?decodeURIComponent(m[1]):"system";
var d=t==="dark"||(t!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);
document.documentElement.classList.toggle("dark",d);
}catch(e){}})();`;

export function ThemeScript() {
  return (
    // eslint-disable-next-line react/no-danger
    <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
  );
}
