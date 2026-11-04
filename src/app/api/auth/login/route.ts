import { signIn } from "@/lib/auth";
import { handle, ok, parseJson } from "@/lib/http";
import { loginSchema } from "@/lib/validators/auth";

// POST /api/auth/login { email, password } -> { data: Session } and the
// session cookie; 401 for a wrong email or password, 403 for an account that
// can't sign in. Exempt from the proxy's sign-in check.
export const POST = handle(async (req) => {
  const { email, password } = await parseJson(req, loginSchema);
  return ok(await signIn(email, password));
});
