import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { NewRequestForm } from "./new-request-form";

// /requests/new (P2.2). The proxy lets ADMIN in with the rest of /requests, but
// only Field Officers and Coordinators can create one.

export const metadata: Metadata = { title: "New request" };

export default async function NewRequestPage() {
  // getSession() in a page is HANDOFF 4.5's one exception; the layout already signed the user in.
  const session = await getSession();
  if (session?.role !== "FIELD_OFFICER" && session?.role !== "COORDINATOR") redirect("/requests");
  return <NewRequestForm />;
}
