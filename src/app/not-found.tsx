import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-base font-medium">Page not found</h1>
      <p className="text-muted-foreground">There is nothing at this address.</p>
      <Link href="/dashboard" className="text-primary underline-offset-4 hover:underline">
        Go to the dashboard
      </Link>
    </main>
  );
}
