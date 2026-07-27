// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Check, Copy, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
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
  createEmailTemplateAction,
  deleteEmailTemplateAction,
  renameEmailTemplateAction,
  setActiveEmailTemplateAction,
} from "@/services/email/template-actions";
import { SUPPORTED_LOCALES } from "@/services/i18n/config";
import type { EditableEmailType } from "@/services/email/template-config";
import type { EmailTemplateLibraryView } from "@/services/email/templates";
import { EmailTemplateEditor, type TestMember } from "./email-template-editor";

type LocaleContent = { subject: string; bodyHtml: string };
type ByLocale = Record<string, LocaleContent | null>;

// One email type's whole library: the read-only built-in default plus the
// fund's custom templates, an "active" picker deciding which one the system
// actually sends, and create / rename / duplicate / delete controls. Editing
// (and previewing the default) opens the per-language editor in a dialog.
export function EmailTemplateSection({
  library,
  defaultLocale,
  testMembers,
}: {
  library: EmailTemplateLibraryView;
  defaultLocale: string;
  testMembers: TestMember[];
}) {
  const t = useTranslations("fund.settings.emailTemplates");
  const router = useRouter();
  const { type } = library;

  // Active selection — optimistic while the switch is in flight; reverts to the
  // server value (or the new one, after refresh) when the transition settles.
  const [activeId, setOptimisticActive] = useOptimistic(
    library.activeTemplateId,
  );
  const [activePending, startActive] = useTransition();
  const [activeError, setActiveError] = useState<string | null>(null);

  const onSelectActive = (templateId: string | null) => {
    setActiveError(null);
    startActive(async () => {
      setOptimisticActive(templateId);
      const result = await setActiveEmailTemplateAction({ type, templateId });
      if ("error" in result) {
        setActiveError(result.error);
        return; // useOptimistic reverts to the server value automatically
      }
      router.refresh();
    });
  };

  // Editor dialog. templateId null = the read-only default view. `seed` carries
  // the initial per-language content for a just-created template (so the editor
  // mounts with real content without waiting for the router refresh).
  const [editing, setEditing] = useState<{
    templateId: string | null;
    seed?: ByLocale;
  } | null>(null);

  const editingTemplate =
    editing && editing.templateId
      ? library.templates.find((tpl) => tpl.id === editing.templateId) ?? null
      : null;
  const editingByLocale: ByLocale =
    editing?.seed ?? editingTemplate?.byLocale ?? {};

  return (
    <div className="space-y-4">
      {activeError && (
        <Alert variant="destructive">
          <AlertDescription>{activeError}</AlertDescription>
        </Alert>
      )}

      <ul className="divide-y divide-border rounded-md border border-border">
        {/* Built-in default row. */}
        <TemplateRow
          label={t("defaultName")}
          isDefault
          isActive={activeId === null}
          activePending={activePending}
          onMakeActive={() => onSelectActive(null)}
          onOpen={() => setEditing({ templateId: null })}
          duplicateControl={
            <CreateTemplateDialog
              type={type}
              templates={library.templates}
              defaultByLocale={library.defaultByLocale}
              defaultSourceId={null}
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title={t("duplicate")}
                >
                  <Copy className="size-3.5" />
                </Button>
              }
              onCreated={(id, seed) => setEditing({ templateId: id, seed })}
            />
          }
        />
        {/* Custom templates. */}
        {library.templates.map((tpl) => (
          <TemplateRow
            key={tpl.id}
            label={tpl.name}
            isActive={activeId === tpl.id}
            activePending={activePending}
            onMakeActive={() => onSelectActive(tpl.id)}
            onOpen={() => setEditing({ templateId: tpl.id })}
            renameControl={
              <RenameTemplateDialog templateId={tpl.id} currentName={tpl.name} />
            }
            deleteControl={
              <DeleteTemplateDialog
                templateId={tpl.id}
                name={tpl.name}
                wasActive={activeId === tpl.id}
              />
            }
            duplicateControl={
              <CreateTemplateDialog
                type={type}
                templates={library.templates}
                defaultByLocale={library.defaultByLocale}
                defaultSourceId={tpl.id}
                trigger={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title={t("duplicate")}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                }
                onCreated={(id, seed) => setEditing({ templateId: id, seed })}
              />
            }
          />
        ))}
      </ul>

      <CreateTemplateDialog
        type={type}
        templates={library.templates}
        defaultByLocale={library.defaultByLocale}
        defaultSourceId={null}
        trigger={
          <Button type="button" variant="outline">
            <Plus className="size-3.5" />
            {t("newTemplate")}
          </Button>
        }
        onCreated={(id, seed) => setEditing({ templateId: id, seed })}
      />

      {/* Editor / default-preview dialog. */}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {editing?.templateId === null
                ? t("defaultName")
                : (editingTemplate?.name ?? t("editTemplate"))}
            </DialogTitle>
            <DialogDescription>
              {editing?.templateId === null
                ? t("defaultReadOnly")
                : t("editTemplateDescription")}
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <EmailTemplateEditor
              type={type}
              templateId={editing.templateId}
              byLocale={editingByLocale}
              defaultByLocale={library.defaultByLocale}
              variables={library.variables}
              defaultLocale={defaultLocale}
              testMembers={testMembers}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TemplateRow({
  label,
  isDefault = false,
  isActive,
  activePending,
  onMakeActive,
  onOpen,
  renameControl,
  duplicateControl,
  deleteControl,
}: {
  label: string;
  isDefault?: boolean;
  isActive: boolean;
  activePending: boolean;
  onMakeActive: () => void;
  onOpen: () => void;
  renameControl?: React.ReactNode;
  duplicateControl?: React.ReactNode;
  deleteControl?: React.ReactNode;
}) {
  const t = useTranslations("fund.settings.emailTemplates");
  return (
    <li className="flex items-center gap-2 px-3 py-2.5">
      <button
        type="button"
        onClick={onMakeActive}
        disabled={isActive || activePending}
        title={isActive ? t("active") : t("makeActive")}
        className={
          "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors " +
          (isActive
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border text-transparent hover:border-primary")
        }
      >
        <Check className="size-3" />
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline"
      >
        {label}
      </button>
      {isActive && <Badge variant="success">{t("active")}</Badge>}
      {isDefault && (
        <Badge variant="outline" className="text-muted-foreground">
          {t("builtIn")}
        </Badge>
      )}
      <div className="flex items-center gap-0.5">
        {duplicateControl}
        {renameControl}
        {deleteControl}
      </div>
    </li>
  );
}

// Create a template — from the built-in default or by duplicating another. On
// success calls onCreated with the new id so the caller can open its editor.
function CreateTemplateDialog({
  type,
  templates,
  defaultByLocale,
  defaultSourceId,
  trigger,
  onCreated,
}: {
  type: EditableEmailType;
  templates: EmailTemplateLibraryView["templates"];
  defaultByLocale: EmailTemplateLibraryView["defaultByLocale"];
  // Preselected source: null = the built-in default, a string = a template id.
  defaultSourceId: string | null;
  trigger: React.ReactElement;
  onCreated: (templateId: string, seed: ByLocale) => void;
}) {
  const t = useTranslations("fund.settings.emailTemplates");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [sourceId, setSourceId] = useState<string>(defaultSourceId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setName("");
    setSourceId(defaultSourceId ?? "");
    setError(null);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createEmailTemplateAction({
        type,
        name,
        sourceTemplateId: sourceId || null,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      // Mirror what the server seeded: the chosen source's content per language,
      // falling back to the built-in default for any language it hadn't authored.
      const source = sourceId
        ? templates.find((tpl) => tpl.id === sourceId)
        : null;
      const seed: ByLocale = Object.fromEntries(
        SUPPORTED_LOCALES.map((locale) => [
          locale,
          source?.byLocale[locale] ?? defaultByLocale[locale],
        ]),
      );
      setOpen(false);
      reset();
      onCreated(result.templateId, seed);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-template-name">{t("nameLabel")}</Label>
            <Input
              id="new-template-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-template-source">{t("sourceLabel")}</Label>
            <select
              id="new-template-source"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              className="w-full rounded-md bg-background px-2.5 py-1.5 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">{t("sourceDefault")}</option>
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              {t("cancel")}
            </DialogClose>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameTemplateDialog({
  templateId,
  currentName,
}: {
  templateId: string;
  currentName: string;
}) {
  const t = useTranslations("fund.settings.emailTemplates");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await renameEmailTemplateAction({ templateId, name });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName(currentName);
          setError(null);
        }
      }}
    >
      <DialogTrigger
        render={
          <Button type="button" variant="ghost" size="icon" title={t("rename")} />
        }
      >
        <Pencil className="size-3.5" />
        <span className="sr-only">{t("rename")}</span>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("renameTitle")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`rename-${templateId}`}>{t("nameLabel")}</Label>
            <Input
              id={`rename-${templateId}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              {t("cancel")}
            </DialogClose>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteTemplateDialog({
  templateId,
  name,
  wasActive,
}: {
  templateId: string;
  name: string;
  wasActive: boolean;
}) {
  const t = useTranslations("fund.settings.emailTemplates");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onDelete = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteEmailTemplateAction({ templateId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title={t("delete")}
          />
        }
      >
        <Trash2 className="size-3.5 text-destructive" />
        <span className="sr-only">{t("delete")}</span>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("deleteTitle")}</DialogTitle>
          <DialogDescription>
            {wasActive
              ? t("deleteActiveDescription", { name })
              : t("deleteDescription", { name })}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            {t("cancel")}
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            onClick={onDelete}
            disabled={pending}
          >
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            {t("delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
