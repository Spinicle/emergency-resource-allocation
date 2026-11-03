import { redirect } from "next/navigation";

// Every role starts on the dashboard, which is role-aware (HANDOFF P2.4).
// Signed-out users never get here: the proxy sends them to /login (P1.6).
export default function Home() {
  redirect("/dashboard");
}
