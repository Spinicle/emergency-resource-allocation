import { NotFoundMessage } from "@/components/not-found-message";

export default function NotFound() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-2 p-6 text-center">
      <NotFoundMessage />
    </main>
  );
}
