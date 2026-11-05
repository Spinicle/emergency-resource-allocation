import { Label } from "@/components/ui/label";

/**
 * A label, one input, and the validation message for it underneath. htmlFor must
 * match the id of the input passed as children.
 */
export function FormField({
  htmlFor,
  label,
  error,
  children,
}: {
  htmlFor: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
