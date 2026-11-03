import { handle, HttpError } from "@/lib/http";

// Any /api path without its own route gets a JSON 404 in the 4.6 shape,
// instead of falling through to the (app) page catch-all's HTML.
// Real routes win: Next matches a static segment before a catch-all.
const noRoute = handle(async (req) => {
  throw new HttpError(404, `No API route at ${req.nextUrl.pathname}`);
});

export const GET = noRoute;
export const POST = noRoute;
export const PUT = noRoute;
export const PATCH = noRoute;
export const DELETE = noRoute;
