import { accountProblem, DUMMY_HASH, findLoginUser, startSession, verifyPassword } from "@/lib/auth";
import { handle, HttpError, ok, parseJson } from "@/lib/http";
import { loginSchema } from "@/lib/validators/auth";

// POST /api/auth/login { email, password } -> { data: Session } and the
// session cookie. Exempt from the proxy's sign-in check.
export const POST = handle(async (req) => {
  const { email, password } = await parseJson(req, loginSchema);
  const user = await findLoginUser(email);

  // One bcrypt compare either way, so an unknown email takes as long as a wrong password.
  const matches = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !matches) throw new HttpError(401, "Email or password is incorrect");

  const problem = accountProblem(user);
  if (problem) throw new HttpError(403, problem);

  return ok(await startSession(user));
});
