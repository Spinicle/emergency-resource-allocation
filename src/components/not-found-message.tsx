import Link from "next/link";

/** The 404 text, used inside the signed-in shell and outside it. */
export function NotFoundMessage() {
  return (
    <>
      <h1 className="text-base font-medium">Page not found</h1>
      <p className="text-muted-foreground">There is nothing at this address.</p>
      <Link href="/dashboard" className="text-primary underline-offset-4 hover:underline">
        Go to the dashboard
      </Link>
    </>
  );
}
