"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { inviteMemberAction } from "@/services/member/admin-actions";

type FieldError = "firstName" | "lastName" | "email";

export function InviteMemberDialog({ triggerLabel }: { triggerLabel: string }) {
  const t = useTranslations("members.admin.invite");
  const [open, setOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<FieldError | null>(null);
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setFirstName("");
    setLastName("");
    setEmail("");
    setError(null);
    setErrorField(null);
  };

  const onSubmit = () => {
    setError(null);
    setErrorField(null);
    startTransition(async () => {
      const result = await inviteMemberAction({ firstName, lastName, email });
      if ("error" in result) {
        setError(result.error);
        setErrorField(result.field ?? null);
        return;
      }
      reset();
      setOpen(false);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button variant="default">
            <Plus />
            {triggerLabel}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="invite-firstName">
            {t("firstNameLabel")}
            <span className="ml-1 text-destructive" aria-hidden>
              *
            </span>
          </Label>
          <Input
            id="invite-firstName"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            autoComplete="given-name"
            aria-invalid={errorField === "firstName"}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="invite-lastName">
            {t("lastNameLabel")}
            <span className="ml-1 text-destructive" aria-hidden>
              *
            </span>
          </Label>
          <Input
            id="invite-lastName"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            autoComplete="family-name"
            aria-invalid={errorField === "lastName"}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="invite-email">
            {t("emailLabel")}
            <span className="ml-1 text-destructive" aria-hidden>
              *
            </span>
          </Label>
          <Input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            aria-invalid={errorField === "email"}
          />
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {t("cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={pending}>
            {pending ? t("inviting") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
