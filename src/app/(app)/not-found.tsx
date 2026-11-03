import { NotFoundMessage } from "@/components/not-found-message";

// A 404 inside the signed-in shell (e.g. an unknown path under the placeholder catch-all).
export default function NotFound() {
  return (
    <div className="flex flex-col gap-2">
      <NotFoundMessage />
    </div>
  );
}
