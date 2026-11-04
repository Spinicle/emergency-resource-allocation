import Link from "next/link";

/**
 * The 404 text, used inside the signed-in shell and outside it. Inside the
 * shell the header already holds the page's <h1>, so pass level "h2" there.
 */
export function NotFoundMessage({ level: Heading = "h1" }: { level?: "h1" | "h2" }) {
  return (
    <>
      <Heading className="text-base font-medium">Page not found</Heading>
      <p className="text-muted-foreground">There is nothing at this address.</p>
      <Link href="/dashboard" className="text-primary underline-offset-4 hover:underline">
        Go to the dashboard
      </Link>
    </>
  );
}
