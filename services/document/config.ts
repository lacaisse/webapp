// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

import { DEFAULT_LOCALE } from "@/services/i18n/config";

// Registry of the printable documents whose wording admins can override per
// fund. Mirrors services/email/template-config.ts but for PDF letters rendered
// via @react-pdf/renderer. Keep keys aligned with the DocumentType enum
// (prisma) — only the types listed here are editable.
//
// Bodies are markdown-ish text (headings `#`/`##`, `**bold**`, `*italic*`,
// `---` rules, blank-line paragraphs) with {{token}} placeholders. The token
// set below is the only thing interpolated; anything else is rejected on save
// so we never ship a letter that prints a broken {{token}}.
export const DOCUMENT_TEMPLATES = {
  CARD_ONBOARDING_LETTER: {
    variables: [
      "fund_name",
      "full_name",
      "website",
      "first_name",
      "last_name",
      "card_number",
      "payment_reference",
    ],
  },
} as const;

export type EditableDocumentType = keyof typeof DOCUMENT_TEMPLATES;

export const EDITABLE_DOCUMENT_TYPES = Object.keys(
  DOCUMENT_TEMPLATES,
) as EditableDocumentType[];

export function isEditableDocumentType(
  value: string,
): value is EditableDocumentType {
  return value in DOCUMENT_TEMPLATES;
}

// Sample values for the live editor preview, so the admin sees realistic
// output without picking a real member.
export const DOCUMENT_PREVIEW_SAMPLE_VALUES: Record<
  EditableDocumentType,
  Record<string, string>
> = {
  CARD_ONBOARDING_LETTER: {
    // fund_name, full_name and website are overridden with the fund's real
    // values at preview time; the rest are illustrative samples.
    fund_name: "Your fund",
    full_name: "Your fund's full name",
    website: "https://example.org",
    first_name: "Alex",
    last_name: "Dupont",
    card_number: "42",
    payment_reference: "+++123/4567/89012+++",
  },
};

// Built-in default bodies. The card onboarding letter is CLASS's French
// letter (the fund the feature was built for); other locales fall back to it
// until translated. Admins override per fund in Settings → Documents.
const CARD_ONBOARDING_LETTER_DEFAULTS: Record<string, string> = {
  fr: `Bonjour {{first_name}},

Bienvenue à la **{{full_name}}**, **{{fund_name}}**. Nous sommes très heureux de te compter parmi nous pour ce projet qui veut rassembler tous les habitants autour d'un objectif essentiel : *généraliser l'alimentation de qualité dans tous les foyers schaerbeekois*. Une alimentation digne et choisie, pour toutes et tous.

Tu trouveras dans ce courrier ta carte personnelle de {{fund_name}} à utiliser dans les commerces conventionnés.

**Prénom et nom** : {{first_name}} {{last_name}}
**Carte {{fund_name}} numéro** : {{card_number}}
**Référence à rajouter lors de ton transfert de cotisation** : {{payment_reference}}
**Compte {{fund_name}} à créditer avec ta cotisation avant le 9 de chaque mois** : BE 82 1036 0037 1868 NICABEBB ouvert chez CRELAN

Tu trouveras toutes les infos pratiques pour utiliser ta carte au dos de ce courrier et sur le site **{{website}}**

[pagebreak]

# INFOS PRATIQUES

## Où utiliser la carte {{fund_name}} ?

Tu peux trouver la liste des commerces actuellement conventionnés sur le site de {{fund_name}} en cliquant sur Commerces dans le menu. Cette liste sera régulièrement mise à jour dès que de nouveaux commerces viendront s'ajouter au projet.

Chaque commerce sera équipé d'un terminal spécial pour la carte {{fund_name}}. Il suffit de poser sa carte sur le terminal et le montant sera déduit automatiquement. A noter que la carte n'est pas sécurisée par défaut. Tu pourras bientôt ajouter un code PIN de ton choix (nous tiendrons au courant les affilié.es dès que la fonctionnalité sera disponible).

Certains commerces ont des modalités particulières pour pouvoir faire ses courses (horaires, nécessité d'être membre pour la BEES coop, etc.). Nous te conseillons de vérifier ces modalités avant de te rendre sur place.

## Comment voir mon solde sur ma carte {{fund_name}} ?

Tu pourras voir ton solde {{fund_name}} directement sur ton smartphone sur la page web de ton compte en scannant le QR code sur ta carte {{fund_name}}.

Si tu n'as pas de smartphone, envoie un email à contact@laclass.be et nous t'enverrons l'url directe à la page web de ta carte.

## Comment sécuriser la carte ?

La carte {{fund_name}} n'a pas de code de sécurité par défaut. Nous travaillons à une fonctionnalité qui permettra aux membres qui le souhaitent de mettre en place un code.

## Quand doit-on payer sa cotisation mensuelle ?

Ta cotisation mensuelle doit être versée avant le 9 du mois sur le compte suivant **BE 82 1036 0037 1868 NICABEBB** ouvert chez CRELAN. N'oublie pas d'ajouter la référence de ta carte sur le transfert afin d'éviter tout retard dans le versement de ton allocation.

Tu peux directement verser ta cotisation via l'application {{fund_name}} ou par virement bancaire. Pour les virements bancaires, nous conseillons de faire un virement automatique afin d'éviter les oublis. Le montant mensuel de ta cotisation est celui que tu nous as communiqué lors de ton inscription et est au minimum de 100 euros.

En participant au projet, les affiliés s'engagent à respecter le même montant de cotisation pendant un semestre et respecter les délais de versements.

Dans le cas où des circonstances imprévues t'empêcheraient de verser le montant de la cotisation, n'hésite pas à nous contacter via contact@laclass.be pour que nous puissions discuter des solutions ensemble.

## Quand reçoit-on en retour les 150€ sur la carte {{fund_name}} ?

La carte {{fund_name}} sera créditée de 150€ le 15 de chaque mois.

## Y a-t-il une durée d'engagement minimum ?

Idéalement, nous souhaitons que les adhérents s'engagent pour au moins un an, avec la possibilité d'ajuster leur contribution au bout de six mois. Nous comprenons bien sûr que des circonstances personnelles peuvent évoluer et entraîner un engagement plus court (déménagement, chômage ou autres raisons pratiques). Vous pouvez nous contacter et nous discuterons de chaque situation au cas par cas ; cela ne devrait pas être un frein pour participer.

## Que se passe-t-il si je ne dépense pas mes 150€ dans le mois en cours ?

Afin que le dispositif fonctionne de manière efficace, il est important que les affiliés dépensent dans la mesure du possible les 150 euros dans le mois qui suit le versement. Cependant le système permet une certaine flexibilité. Si les 150 euros ne sont pas dépensés d'ici le 15 du mois suivant, le solde se reportera automatiquement sur le mois suivant.

A partir de 900€ de solde positif (l'équivalent de 6 mois de cotisation), le compte sera suspendu et les cotisations ainsi que les reversements mensuels seront stoppés. Nous prendrons contact avec la personne pour discuter de la pertinence pour elle de rester dans le projet et le cas échéant lui permettre de sortir du dispositif en lui reversant le montant qu'elle a cotisé. Un email d'avertissement sera envoyé à partir de 450 euros de solde positif (l'équivalent de 3 mois de cotisation), afin de prévenir les personnes suffisamment en amont d'une potentielle suspension de compte, et ce afin d'éviter au maximum cette situation.

## Qui peut utiliser ma carte {{fund_name}} ?

La carte {{fund_name}} peut être utilisée par quiconque dans le foyer à condition de connaître le code secret le cas échéant.

## Que se passe-t-il si ma carte est perdue ou volée ?

Contacte immédiatement contact@laclass.be pour le signaler. Une autre carte te sera attribuée, en transférant le solde restant de ton ancienne carte. Note que {{fund_name}} ne pourra rembourser aucun paiement qui est déjà passé sur la carte.

## Que se passe-t-il si je souhaite quitter le projet ?

Tout membre souhaitant quitter le projet peut le faire en prévenant {{fund_name}} 1 mois à l'avance.

## Où trouver plus d'informations sur {{fund_name}} ?

Le site web de {{fund_name}} est disponible à l'adresse suivante : **{{website}}**. Tu y retrouveras toutes les informations sur le projet ainsi que les commerces participants.

Pour toutes questions, n'hésite pas à nous contacter via contact@laclass.be.`,
};

// The built-in default body for a document type in the given locale, falling
// back to the default locale then French (the only authored copy today).
export function documentDefaultBody(
  type: EditableDocumentType,
  locale: string,
): string {
  // Only one editable document type today.
  const byLocale =
    type === "CARD_ONBOARDING_LETTER" ? CARD_ONBOARDING_LETTER_DEFAULTS : {};
  return byLocale[locale] ?? byLocale[DEFAULT_LOCALE] ?? byLocale.fr ?? "";
}

// Replace {{token}} with vars[token]. Unknown tokens are left literal (save
// validation already rejects those — this only guards against drift).
export function interpolateDocument(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    name in vars ? vars[name] : whole,
  );
}

// All distinct {{token}} names referenced in a string.
export function extractDocumentPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) found.add(m[1]);
  return [...found];
}

// {{token}}s used in the body that aren't in the type's allowed set — blocks a
// broken template before it's stored.
export function findUnknownDocumentPlaceholders(
  type: EditableDocumentType,
  body: string,
): string[] {
  const allowed = new Set<string>(DOCUMENT_TEMPLATES[type].variables);
  return extractDocumentPlaceholders(body).filter((name) => !allowed.has(name));
}

// Zod schema for the save action. Body is markdown-ish text; error messages are
// i18n keys (resolved by the caller), matching the email-template pattern.
export const SaveDocumentTemplateSchema = z.object({
  type: z.enum(
    EDITABLE_DOCUMENT_TYPES as [
      EditableDocumentType,
      ...EditableDocumentType[],
    ],
  ),
  body: z
    .string()
    .trim()
    .min(1, { error: "fund.settings.documentTemplates.errors.bodyRequired" })
    .max(40000, {
      error: "fund.settings.documentTemplates.errors.bodyTooLong",
    }),
});

export type SaveDocumentTemplateInput = z.infer<
  typeof SaveDocumentTemplateSchema
>;

// Input shape for the live preview (no length constraints — transient).
export const PreviewDocumentTemplateSchema = z.object({
  type: z.enum(
    EDITABLE_DOCUMENT_TYPES as [
      EditableDocumentType,
      ...EditableDocumentType[],
    ],
  ),
  body: z.string(),
});

export type PreviewDocumentTemplateInput = z.infer<
  typeof PreviewDocumentTemplateSchema
>;
