// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Pencil } from "lucide-react";
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
import {
  type EditMemberProfileField,
  updateMemberProfileAction,
} from "@/services/member/profile-actions";

type Values = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  postalCode: string;
  city: string;
  iban: string;
  householdAdults: string;
  householdChildren: string;
  contributionAmount: string;
  notes: string;
};

export function EditProfileDialog({
  memberId,
  member,
  showContribution,
}: {
  memberId: string;
  member: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
    address: string | null;
    postalCode: string | null;
    city: string | null;
    iban: string | null;
    householdAdults: number;
    householdChildren: number;
    contributionAmount: string | null;
    notes: string | null;
    // The member's tier target/min, for the committed-amount hint. Null when
    // the member has no tier yet.
    tierTarget: string | null;
    tierMin: string | null;
  };
  // Only FIXED_PERIOD funds with tiers show the commitment-amount field.
  showContribution: boolean;
}) {
  const t = useTranslations("members.admin.edit");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<EditMemberProfileField | null>(
    null,
  );

  const initial = (): Values => ({
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    phone: member.phone ?? "",
    address: member.address ?? "",
    postalCode: member.postalCode ?? "",
    city: member.city ?? "",
    iban: member.iban ?? "",
    householdAdults: String(member.householdAdults),
    householdChildren: String(member.householdChildren),
    contributionAmount: member.contributionAmount ?? "",
    notes: member.notes ?? "",
  });

  const [values, setValues] = useState<Values>(initial);

  const set = (key: keyof Values) => (value: string) =>
    setValues((v) => ({ ...v, [key]: value }));

  const reset = () => {
    setValues(initial());
    setError(null);
    setErrorField(null);
  };

  const onSubmit = () => {
    setError(null);
    setErrorField(null);
    startTransition(async () => {
      const result = await updateMemberProfileAction({ memberId, ...values });
      if ("error" in result) {
        setError(result.error);
        setErrorField(result.field ?? null);
        return;
      }
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
          <Button variant="outline" size="sm">
            <Pencil />
            {t("button")}
          </Button>
        }
      />
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="edit-firstName"
            label={t("firstNameLabel")}
            required
            value={values.firstName}
            onChange={set("firstName")}
            invalid={errorField === "firstName"}
            autoComplete="given-name"
          />
          <Field
            id="edit-lastName"
            label={t("lastNameLabel")}
            required
            value={values.lastName}
            onChange={set("lastName")}
            invalid={errorField === "lastName"}
            autoComplete="family-name"
          />
          <div className="sm:col-span-2">
            <Field
              id="edit-email"
              label={t("emailLabel")}
              required
              type="email"
              value={values.email}
              onChange={set("email")}
              invalid={errorField === "email"}
              autoComplete="email"
            />
          </div>
          <Field
            id="edit-phone"
            label={t("phoneLabel")}
            type="tel"
            value={values.phone}
            onChange={set("phone")}
            invalid={errorField === "phone"}
            autoComplete="tel"
          />
          <Field
            id="edit-iban"
            label={t("ibanLabel")}
            value={values.iban}
            onChange={set("iban")}
            invalid={errorField === "iban"}
          />
          <div className="sm:col-span-2">
            <Field
              id="edit-address"
              label={t("addressLabel")}
              value={values.address}
              onChange={set("address")}
              invalid={errorField === "address"}
              autoComplete="street-address"
            />
          </div>
          <Field
            id="edit-postalCode"
            label={t("postalCodeLabel")}
            value={values.postalCode}
            onChange={set("postalCode")}
            invalid={errorField === "postalCode"}
            autoComplete="postal-code"
          />
          <Field
            id="edit-city"
            label={t("cityLabel")}
            value={values.city}
            onChange={set("city")}
            invalid={errorField === "city"}
            autoComplete="address-level2"
          />
          <Field
            id="edit-householdAdults"
            label={t("householdAdultsLabel")}
            type="number"
            min={0}
            value={values.householdAdults}
            onChange={set("householdAdults")}
            invalid={errorField === "householdAdults"}
          />
          <Field
            id="edit-householdChildren"
            label={t("householdChildrenLabel")}
            type="number"
            min={0}
            value={values.householdChildren}
            onChange={set("householdChildren")}
            invalid={errorField === "householdChildren"}
          />
          {showContribution && (
            <div className="sm:col-span-2">
              <Field
                id="edit-contributionAmount"
                label={t("contributionAmountLabel")}
                hint={
                  member.tierTarget
                    ? t("contributionAmountHint", {
                        target: member.tierTarget,
                        min: member.tierMin ?? member.tierTarget,
                      })
                    : t("contributionAmountHintNoTier")
                }
                type="number"
                min={0}
                step="0.01"
                value={values.contributionAmount}
                onChange={set("contributionAmount")}
                invalid={errorField === "contributionAmount"}
              />
            </div>
          )}
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="edit-notes">{t("notesLabel")}</Label>
            <textarea
              id="edit-notes"
              rows={3}
              value={values.notes}
              onChange={(e) => set("notes")(e.target.value)}
              aria-invalid={errorField === "notes"}
              className="w-full rounded-md bg-background px-2.5 py-1.5 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
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
            {pending ? t("saving") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  required,
  invalid,
  type,
  min,
  step,
  autoComplete,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  invalid?: boolean;
  type?: string;
  min?: number;
  step?: string;
  autoComplete?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {required && (
          <span className="ml-1 text-destructive" aria-hidden>
            *
          </span>
        )}
      </Label>
      <Input
        id={id}
        type={type}
        min={min}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid}
        autoComplete={autoComplete}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
