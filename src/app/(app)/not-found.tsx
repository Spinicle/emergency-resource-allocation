import { NotFoundMessage } from "@/components/not-found-message";

// A 404 inside the signed-in shell: a page under it calling notFound() (an unknown id, say).
export default function NotFound() {
  return (
    <div className="flex flex-col gap-2">
      <NotFoundMessage level="h2" />
    </div>
  );
}
