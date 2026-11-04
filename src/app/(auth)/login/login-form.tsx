"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FieldErrors } from "@/lib/api-contract";
import type { Session } from "@/lib/auth";
import { api, ApiError } from "@/lib/client";

/** Email and password, posted to /api/auth/login. next is already checked by safeNext(). */
export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [fields, setFields] = useState<FieldErrors>({});

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFields({});
    try {
      await api<Session>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      router.replace(next);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sign-in failed");
      if (err instanceof ApiError && err.fields) setFields(err.fields);
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <Field name="email" label="Email" type="email" autoComplete="username" autoFocus error={fields.email} />
      <Field name="password" label="Password" type="password" autoComplete="current-password" error={fields.password} />
      <Button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

/** A labelled input (id = name) with the server's message for it underneath. */
function Field({
  name,
  label,
  error,
  ...input
}: { name: string; label: string; error?: string } & React.ComponentProps<typeof Input>) {
  const errorId = `${name}-error`;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} required aria-invalid={!!error} aria-describedby={error ? errorId : undefined} {...input} />
      {error && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
