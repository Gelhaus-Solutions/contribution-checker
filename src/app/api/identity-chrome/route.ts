import { auth } from "@/auth";
import { identityChrome } from "@/lib/identity-chrome";

/**
 * The route the shared header controls ask (GPlatform Identity, GPLATSSO-33):
 * the apps picker and the account popup draw from it, through
 * `@ghub/identity-chrome`. 404 on an instance that has not set them up.
 *
 * **Only a verified address is reported.** The token lets this server ask
 * Identity about an address, and an unverified one is a way to ask about
 * somebody else, so a person whose address is not verified, or whose account
 * an administrator restricted, is answered as nobody.
 *
 * Same origin as the page on purpose: the browser half calls it with the
 * page's own cookie, and the token never leaves this process.
 */

const answer = identityChrome?.handler(async () => {
  const user = (await auth())?.user;
  return user && !user.restricted && user.emailVerified === true && user.email
    ? { email: user.email }
    : null;
});

export async function GET(request: Request): Promise<Response> {
  if (answer === undefined) return new Response(null, { status: 404 });
  return answer(request);
}
