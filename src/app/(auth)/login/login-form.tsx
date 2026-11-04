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
      <Field id="email" label="Email" error={fields.email}>
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus
          aria-invalid={!!fields.email} aria-describedby={fields.email ? "email-error" : undefined} />
      </Field>
      <Field id="password" label="Password" error={fields.password}>
        <Input id="password" name="password" type="password" autoComplete="current-password" required
          aria-invalid={!!fields.password} aria-describedby={fields.password ? "password-error" : undefined} />
      </Field>
      <Button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
