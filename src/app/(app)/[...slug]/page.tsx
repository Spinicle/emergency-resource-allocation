import { Construction } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { findNavItem } from "@/config/nav";

// Placeholder for nav pages that aren't built yet, so every sidebar link opens
// inside the shell. A real page.tsx at the same path takes over on its own
// (Next matches a static route before a catch-all); nothing here needs editing.
// P2.8: delete this file once every page in src/config/nav.ts exists.

async function itemFor(params: Promise<{ slug: string[] }>) {
  const { slug } = await params;
  return findNavItem(`/${slug.join("/")}`);
}

export async function generateMetadata({ params }: PageProps<"/[...slug]">): Promise<Metadata> {
  const item = await itemFor(params);
  return { title: item?.label ?? "Not found" };
}

export default async function NotBuiltYet({ params }: PageProps<"/[...slug]">) {
  const item = await itemFor(params);
  if (!item) notFound();

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <item.icon className="size-4 text-muted-foreground" />
          {item.label}
        </CardTitle>
        <CardDescription>{item.summary}</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-2 text-muted-foreground">
        <Construction className="size-4" />
        Not built yet. It arrives with {item.owner}.
      </CardContent>
    </Card>
  );
}
