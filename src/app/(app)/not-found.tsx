import Link from "next/link";

// A 404 inside the signed-in shell (e.g. an unknown path under the placeholder catch-all).
export default function NotFound() {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-base font-medium">Page not found</h2>
      <p className="text-muted-foreground">There is nothing at this address.</p>
      <Link href="/dashboard" className="text-primary underline-offset-4 hover:underline">
        Go to the dashboard
      </Link>
    </div>
  );
}
