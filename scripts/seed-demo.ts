// SPDX-License-Identifier: AGPL-3.0-or-later
/* eslint-disable no-console */
// Demo seed for an SSA walkthrough.
//
// Creates a fully-populated Fund at `caisse.lacaisse.eu`, attaches the
// existing `kevin@pay.brussels` user as OWNER, and fills it with showcase
// data: tiers, allocation periods, onboarding fields, ~60 members + cards,
// ~20 merchants, ~4 months of bank transactions, the mints they triggered,
// referrals, and a sample of transactional emails.
//
// Usage (against prod):
//
//   npx prisma generate
//   DATABASE_URL='<prod-pooled>' DIRECT_URL='<prod-direct>' \
//     npx tsx scripts/seed-demo.ts
//
// Pass `--reset` to wipe the existing fund (everything cascades off Fund) and
// re-seed from scratch. Pass `--dry` to print what it would do without writing.

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../services/db/generated/client";

// Bypass services/db/prisma.ts because it pulls in `server-only`, which fails
// to resolve outside Next.js. Construct the client directly here; same adapter
// + connection string the app uses at runtime.
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// =============================================================================
// Config
// =============================================================================

const FUND_DOMAIN = "caisse.lacaisse.eu";
const FUND_NAME = "Caisse Solidaire de Bruxelles";
const OWNER_EMAIL = "kevin@pay.brussels";

// Pinned "today" so the seed is reproducible. Matches the project's session
// clock (2026-05-12). Most timestamps below are relative to this.
const TODAY = new Date("2026-05-12T10:00:00.000Z");

const RESET = process.argv.includes("--reset");
const DRY = process.argv.includes("--dry");

// =============================================================================
// Generators
// =============================================================================

const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function refCode(len: number): string {
  const b = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += REF_ALPHABET[b[i] % REF_ALPHABET.length];
  return out;
}
const generatePaymentReference = () => refCode(8);
const generateReferralCode = () => refCode(6);

function generateCardSerial(): string {
  // 14 hex chars, uppercase. Mirrors CitizenPay's NFC UUID format.
  return randomBytes(7).toString("hex").toUpperCase();
}

function generateAccountAddress(): string {
  return "0x" + randomBytes(20).toString("hex");
}

function generateTxHash(): string {
  return "0x" + randomBytes(32).toString("hex");
}

function generateBelgianIban(): string {
  // BE + 14 digits. Not checksum-valid; the demo doesn't validate.
  let digits = "";
  for (let i = 0; i < 14; i++) digits += Math.floor(Math.random() * 10);
  return "BE" + digits;
}

function pick<T>(arr: readonly T[], i: number): T {
  return arr[((i % arr.length) + arr.length) % arr.length];
}

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function startOfMonth(year: number, month: number): Date {
  // month is 1-indexed (1 = January)
  return new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
}

// Round a euro amount to 2 decimals as a string for Prisma Decimal columns.
function money(n: number): string {
  return n.toFixed(2);
}

// =============================================================================
// Demo data sources
// =============================================================================

const FIRST_NAMES = [
  "Aïcha", "Amine", "Anaïs", "Antoine", "Bart", "Camille", "Chloé",
  "Daan", "Delphine", "Dimitri", "Elena", "Élise", "Emma", "Fatima",
  "Florence", "François", "Gaëlle", "Greta", "Hadrien", "Hakim", "Hicham",
  "Inès", "Ines", "Jasper", "Jean", "Julie", "Kenza", "Laurent",
  "Léa", "Lina", "Lize", "Lucas", "Mahmoud", "Manon", "Marie",
  "Maryam", "Mathieu", "Mehdi", "Mireille", "Mohamed", "Nadia", "Naïma",
  "Nathan", "Nora", "Olivia", "Pascal", "Pieter", "Rachid", "Romain",
  "Sabrina", "Salim", "Sara", "Sébastien", "Sofia", "Sophie", "Stijn",
  "Sven", "Thierry", "Thomas", "Tom", "Valentine", "Victor", "Vincent",
  "Wouter", "Yasmine", "Younes", "Yves", "Zoé",
];

const LAST_NAMES = [
  "Aerts", "Benali", "Bertrand", "Bogaert", "Bouchard", "Charlier",
  "Claes", "Cornelis", "De Backer", "De Bruyne", "De Clercq", "De Pauw",
  "De Smet", "De Vos", "Declerck", "Delvaux", "Demir", "Denis", "Dubois",
  "Dupont", "El Amrani", "El Hajji", "Fontaine", "Geerts", "Gérard",
  "Goossens", "Hamdi", "Hendrickx", "Janssens", "Jacobs", "Kaya", "Khan",
  "Lacroix", "Lambert", "Laurent", "Lefebvre", "Lemmens", "Leroy",
  "Maes", "Martens", "Marchal", "Mahmoud", "Mertens", "Meurice",
  "Moreau", "Nguyen", "Özdemir", "Pauwels", "Peeters", "Petit",
  "Renard", "Roland", "Rousseau", "Saidi", "Simon", "Smets", "Tirard",
  "Van Damme", "Van den Berg", "Vandenbroucke", "Vermeulen", "Verstraete",
  "Wauters", "Willems", "Wouters", "Yilmaz",
];

const STREETS = [
  "rue de Flandre", "rue Haute", "rue du Marché-aux-Herbes",
  "rue Antoine Dansaert", "rue de Laeken", "avenue Louise",
  "chaussée d'Ixelles", "chaussée de Wavre", "boulevard Anspach",
  "rue de la Loi", "rue Vieille Halle aux Blés", "place Sainte-Catherine",
  "rue Neuve", "rue du Bailli", "rue des Bouchers",
  "rue de l'Étuve", "avenue Brugmann", "chaussée de Charleroi",
  "rue de Stassart", "rue du Trône", "rue Royale", "rue de la Régence",
  "rue du Page", "rue Lesbroussart", "avenue de Tervueren",
];

// Brussels-region postal codes — 1000 (centre), 1030 (Schaerbeek),
// 1040 (Etterbeek), 1050 (Ixelles), 1060 (Saint-Gilles), 1080 (Molenbeek),
// 1090 (Jette), 1140 (Evere), 1180 (Uccle), 1190 (Forest), 1210 (Saint-Josse).
const POSTALS: Array<[string, string]> = [
  ["1000", "Bruxelles"],
  ["1030", "Schaerbeek"],
  ["1040", "Etterbeek"],
  ["1050", "Ixelles"],
  ["1060", "Saint-Gilles"],
  ["1080", "Molenbeek-Saint-Jean"],
  ["1090", "Jette"],
  ["1140", "Evere"],
  ["1180", "Uccle"],
  ["1190", "Forest"],
  ["1210", "Saint-Josse-ten-Noode"],
];

function makeAddress(i: number) {
  const [postal, city] = pick(POSTALS, i);
  const street = pick(STREETS, i * 3 + 1);
  const num = ((i * 7) % 180) + 1;
  return { address: `${num} ${street}`, postalCode: postal, city };
}

function emailFor(first: string, last: string, i: number): string {
  const slug = `${first}.${last}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]+/g, ".")
    .replace(/^\.|\.$/g, "");
  // Mix domains so the list doesn't look generated.
  const domains = ["gmail.com", "hotmail.com", "outlook.be", "skynet.be", "proton.me"];
  return `${slug}${i % 7 === 0 ? i : ""}@${pick(domains, i)}`;
}

// =============================================================================
// Merchants
// =============================================================================

type MerchantSeed = {
  name: string;
  description: string;
  contact: string;
  emailLocal: string;
  emailDomain: string;
  phoneTail: string;
  website: string;
  conditions: string | null;
  businessType: "retail" | "food" | "services";
};

const MERCHANT_SEEDS: MerchantSeed[] = [
  { name: "Boulangerie Saint-Géry", description: "Pains au levain, viennoiseries traditionnelles, pâtisseries du jour.", contact: "Florence Lambert", emailLocal: "contact", emailDomain: "boulangerie-stgery.be", phoneTail: "211 34 56", website: "https://boulangerie-stgery.be", conditions: "Produits frais uniquement.", businessType: "food" },
  { name: "Épicerie Bio La Ruche", description: "Épicerie zéro déchet, fruits et légumes locaux, produits en vrac.", contact: "Mohamed El Hajji", emailLocal: "hello", emailDomain: "laruche-bio.be", phoneTail: "534 12 89", website: "https://laruche-bio.be", conditions: "Achat minimum €5.", businessType: "food" },
  { name: "Librairie La Page", description: "Librairie indépendante généraliste, BD, jeunesse, polar.", contact: "Sophie Dubois", emailLocal: "info", emailDomain: "lapage.be", phoneTail: "640 22 11", website: "https://lapage.be", conditions: null, businessType: "retail" },
  { name: "Café Métropole", description: "Café de quartier, sandwichs, soupes maison, terrasse ombragée.", contact: "Pieter Janssens", emailLocal: "bonjour", emailDomain: "cafemetropole.be", phoneTail: "218 76 54", website: "https://cafemetropole.be", conditions: "Hors boissons alcoolisées.", businessType: "food" },
  { name: "Vélo Atelier Bruxelles", description: "Réparation et entretien de vélos, vente de pièces et accessoires.", contact: "Daan Cornelis", emailLocal: "atelier", emailDomain: "veloatelier.brussels", phoneTail: "412 33 77", website: "https://veloatelier.brussels", conditions: null, businessType: "services" },
  { name: "Maraîcher Les Jardins du Pajottenland", description: "Légumes de saison, paniers hebdomadaires, livraison locale.", contact: "Greta Maes", emailLocal: "panier", emailDomain: "jardinsdupajottenland.be", phoneTail: "475 19 02", website: "https://jardinsdupajottenland.be", conditions: "Réservation 48h à l'avance.", businessType: "food" },
  { name: "Pharmacie de la Place", description: "Officine de quartier, conseil santé, parapharmacie.", contact: "Pascal Charlier", emailLocal: "officine", emailDomain: "pharma-place.be", phoneTail: "522 09 87", website: "https://pharma-place.be", conditions: "Hors médicaments délivrés sur ordonnance.", businessType: "retail" },
  { name: "Atelier Couture Anaïs", description: "Retouches, créations sur mesure, ateliers couture pour adultes et enfants.", contact: "Anaïs Petit", emailLocal: "atelier", emailDomain: "couture-anais.be", phoneTail: "486 71 09", website: "https://couture-anais.be", conditions: null, businessType: "services" },
  { name: "Fromagerie Le Roi du Plateau", description: "Affinage maison, fromages belges et européens, plateaux sur commande.", contact: "Yves Delvaux", emailLocal: "info", emailDomain: "roiduplateau.be", phoneTail: "538 47 22", website: "https://roiduplateau.be", conditions: null, businessType: "food" },
  { name: "Cordonnerie Marchal", description: "Réparation chaussures et maroquinerie, clés minute, copies plates et plates.", contact: "Thierry Marchal", emailLocal: "contact", emailDomain: "cordonnerie-marchal.be", phoneTail: "640 88 14", website: "https://cordonnerie-marchal.be", conditions: null, businessType: "services" },
  { name: "Salon de Thé Aïcha", description: "Pâtisseries orientales maison, thé à la menthe, formules brunch.", contact: "Aïcha Benali", emailLocal: "salon", emailDomain: "salonaicha.be", phoneTail: "478 33 21", website: "https://salonaicha.be", conditions: null, businessType: "food" },
  { name: "Coiffeur l'Eclat", description: "Coupe femme, homme et enfant, coloration végétale.", contact: "Sabrina Khan", emailLocal: "rdv", emailDomain: "leclat-coiffure.be", phoneTail: "640 19 87", website: "https://leclat-coiffure.be", conditions: null, businessType: "services" },
  { name: "Poissonnerie du Vieux Marché", description: "Poissons frais de la Mer du Nord, plateaux fruits de mer.", contact: "Bart De Smet", emailLocal: "marche", emailDomain: "poissonnerieduvieuxmarche.be", phoneTail: "513 22 14", website: "https://poissonnerieduvieuxmarche.be", conditions: "Hors champagne et caviar.", businessType: "food" },
  { name: "Quincaillerie Du Coin", description: "Outillage, plomberie, électricité, peinture — conseils pratiques.", contact: "Stijn De Pauw", emailLocal: "magasin", emailDomain: "quincaillerieducoin.be", phoneTail: "411 88 09", website: "https://quincaillerieducoin.be", conditions: null, businessType: "retail" },
  { name: "Garage Vélo Solidaire", description: "Cours d'auto-réparation, location de vélos, atelier participatif.", contact: "Sven Wouters", emailLocal: "asbl", emailDomain: "velosolidaire.be", phoneTail: "489 47 81", website: "https://velosolidaire.be", conditions: "Adhésion annuelle €15.", businessType: "services" },
  { name: "Traiteur Saveurs du Maghreb", description: "Plats préparés, couscous, tajines, traiteur événementiel.", contact: "Hakim Demir", emailLocal: "traiteur", emailDomain: "saveursmaghreb.be", phoneTail: "475 11 66", website: "https://saveursmaghreb.be", conditions: "Commande minimum €15.", businessType: "food" },
  { name: "Brasserie de la Senne — Tap Room", description: "Brasserie artisanale locale, dégustation et vente à emporter.", contact: "Wouter Aerts", emailLocal: "taproom", emailDomain: "brasseriedelasenne-shop.be", phoneTail: "412 04 19", website: "https://brasseriedelasenne-shop.be", conditions: "Hors événements privés.", businessType: "food" },
  { name: "Jouets Solidaires Tirelire", description: "Jeux et jouets d'occasion, ateliers de réparation, dépôt-vente.", contact: "Camille Roland", emailLocal: "tirelire", emailDomain: "jouets-tirelire.be", phoneTail: "489 32 17", website: "https://jouets-tirelire.be", conditions: null, businessType: "retail" },
  { name: "Réparation Électroménager Le Phénix", description: "Réparation de lave-linge, frigos, petits appareils — devis gratuit.", contact: "Mehdi El Amrani", emailLocal: "depannage", emailDomain: "phenix-repar.be", phoneTail: "476 88 02", website: "https://phenix-repar.be", conditions: "Hors prestations sous garantie constructeur.", businessType: "services" },
  { name: "Fleurs et Plantes Belladone", description: "Fleuriste de quartier, bouquets sur mesure, plantes d'intérieur.", contact: "Élise Vermeulen", emailLocal: "fleurs", emailDomain: "belladone-fleuriste.be", phoneTail: "640 71 23", website: "https://belladone-fleuriste.be", conditions: null, businessType: "retail" },
];

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log(
    `[seed-demo] Target fund: ${FUND_DOMAIN} (owner: ${OWNER_EMAIL})`,
  );
  if (DRY) console.log(`[seed-demo] DRY RUN — no writes will be performed.`);

  // ---------------------------------------------------------------------------
  // 1. Find the owner user. They must already exist (signed up via Better Auth).
  // ---------------------------------------------------------------------------

  const owner = await prisma.user.findUnique({
    where: { email: OWNER_EMAIL },
    select: { id: true, email: true, name: true },
  });
  if (!owner) {
    console.error(
      `\n✗ No user found with email ${OWNER_EMAIL}.\n` +
        `  Sign up at https://auth.${process.env.APP_DOMAIN ?? "lacaisse.eu"}/signup first,\n` +
        `  then re-run this script.`,
    );
    process.exit(1);
  }
  console.log(`[seed-demo] Owner user: ${owner.email} (${owner.id})`);

  // ---------------------------------------------------------------------------
  // 2. Handle pre-existing fund.
  // ---------------------------------------------------------------------------

  const existing = await prisma.fund.findUnique({
    where: { domain: FUND_DOMAIN },
    select: { id: true },
  });
  if (existing) {
    if (!RESET) {
      console.error(
        `\n✗ Fund "${FUND_DOMAIN}" already exists.\n` +
          `  Pass --reset to wipe and re-seed (cascades through all child rows).`,
      );
      process.exit(1);
    }
    if (DRY) {
      console.log(`[seed-demo] [dry] Would delete fund ${existing.id}`);
    } else {
      console.log(`[seed-demo] Deleting existing fund ${existing.id}…`);
      await prisma.fund.delete({ where: { id: existing.id } });
    }
  }

  if (DRY) {
    console.log(
      `[seed-demo] [dry] Would create fund + ~60 members + ~20 merchants + bank txs + mints.`,
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // 3. Create the fund.
  // ---------------------------------------------------------------------------

  const fund = await prisma.fund.create({
    data: {
      domain: FUND_DOMAIN,
      name: FUND_NAME,
      primaryColor: "#1a5fa4",
      tokenName: "Solidaire",
      tokenSymbol: "SOL",
      allocationMode: "FIXED_PERIOD",
      referralBonusAmount: "25.00",
      defaultLocale: "fr",
      timezone: "Europe/Brussels",
      termsUrl: "https://caisse.lacaisse.eu/terms",
      privacyUrl: "https://caisse.lacaisse.eu/privacy",
      requireMemberEmailVerification: true,
      requireMerchantEmailVerification: true,
      citizenPayFundId: "cp-demo-bxl-001",
      citizenPayLastSyncedAt: addDays(TODAY, -1),
      staff: { create: { userId: owner.id, role: "OWNER" } },
    },
  });
  console.log(`[seed-demo] Fund created: ${fund.id}`);

  // ---------------------------------------------------------------------------
  // 4. Tiers.
  // ---------------------------------------------------------------------------

  const tiersInput = [
    {
      name: "Solidaire",
      minContribution: money(50),
      maxContribution: money(100),
      allocationAmount: money(120),
      position: 0,
    },
    {
      name: "Standard",
      minContribution: money(100),
      maxContribution: money(200),
      allocationAmount: money(150),
      position: 1,
    },
    {
      name: "Soutien",
      minContribution: money(150),
      maxContribution: money(300),
      allocationAmount: money(175),
      position: 2,
    },
  ] as const;

  const tiers = await Promise.all(
    tiersInput.map((t) =>
      prisma.allocationTier.create({
        data: { fundId: fund.id, ...t },
      }),
    ),
  );
  const tierByName = Object.fromEntries(tiers.map((t) => [t.name, t]));
  console.log(`[seed-demo] Tiers: ${tiers.map((t) => t.name).join(", ")}`);

  // ---------------------------------------------------------------------------
  // 5. Allocation periods. Today is 2026-05-12 → Feb/Mar/Apr CLOSED, May OPEN.
  // ---------------------------------------------------------------------------

  const periodsInput = [
    {
      label: "2026-02",
      startsAt: startOfMonth(2026, 2),
      cutoffDate: new Date(Date.UTC(2026, 1, 25)),
      closedAt: new Date(Date.UTC(2026, 1, 28)),
      status: "CLOSED" as const,
    },
    {
      label: "2026-03",
      startsAt: startOfMonth(2026, 3),
      cutoffDate: new Date(Date.UTC(2026, 2, 25)),
      closedAt: new Date(Date.UTC(2026, 2, 28)),
      status: "CLOSED" as const,
    },
    {
      label: "2026-04",
      startsAt: startOfMonth(2026, 4),
      cutoffDate: new Date(Date.UTC(2026, 3, 25)),
      closedAt: new Date(Date.UTC(2026, 3, 28)),
      status: "CLOSED" as const,
    },
    {
      label: "2026-05",
      startsAt: startOfMonth(2026, 5),
      cutoffDate: new Date(Date.UTC(2026, 4, 25)),
      closedAt: null,
      status: "OPEN" as const,
    },
  ];
  const periods = await Promise.all(
    periodsInput.map((p) =>
      prisma.allocationPeriod.create({
        data: { fundId: fund.id, ...p },
      }),
    ),
  );
  const periodByLabel = Object.fromEntries(periods.map((p) => [p.label, p]));
  const closedPeriods = periods.filter((p) => p.status === "CLOSED");
  const openPeriod = periods.find((p) => p.status === "OPEN")!;
  console.log(`[seed-demo] Periods: ${periods.map((p) => `${p.label}/${p.status}`).join(", ")}`);

  // ---------------------------------------------------------------------------
  // 6. Onboarding fields (member + merchant custom extras).
  // ---------------------------------------------------------------------------

  await prisma.onboardingField.createMany({
    data: [
      {
        fundId: fund.id,
        target: "MEMBER",
        key: "profession",
        type: "TEXT",
        label: "Profession",
        helpText: "Pour mieux comprendre notre communauté.",
        required: false,
        position: 0,
      },
      {
        fundId: fund.id,
        target: "MEMBER",
        key: "heardAboutUs",
        type: "SELECT",
        label: "Comment avez-vous connu la caisse ?",
        required: false,
        position: 1,
        config: {
          options: [
            { value: "friend", label: "Bouche-à-oreille" },
            { value: "social", label: "Réseaux sociaux" },
            { value: "flyer", label: "Flyer / affiche" },
            { value: "press", label: "Presse" },
            { value: "other", label: "Autre" },
          ],
        },
      },
      {
        fundId: fund.id,
        target: "MEMBER",
        key: "newsletter",
        type: "CHECKBOX",
        label: "Je souhaite recevoir la newsletter mensuelle",
        required: false,
        position: 2,
      },
      {
        fundId: fund.id,
        target: "MERCHANT",
        key: "businessType",
        type: "SELECT",
        label: "Type d'activité",
        required: true,
        position: 0,
        config: {
          options: [
            { value: "food", label: "Alimentation" },
            { value: "retail", label: "Commerce de détail" },
            { value: "services", label: "Services" },
            { value: "other", label: "Autre" },
          ],
        },
      },
      {
        fundId: fund.id,
        target: "MERCHANT",
        key: "openingHours",
        type: "TEXTAREA",
        label: "Horaires d'ouverture",
        required: false,
        position: 1,
      },
    ],
  });
  console.log(`[seed-demo] Onboarding fields: 3 member + 2 merchant`);

  // ---------------------------------------------------------------------------
  // 7. Merchants.
  // ---------------------------------------------------------------------------

  // Distribute statuses: 14 ACTIVE, 3 PENDING, 2 INACTIVE, 1 REJECTED = 20.
  const merchantStatuses: Array<
    "ACTIVE" | "PENDING" | "INACTIVE" | "REJECTED"
  > = [
    "ACTIVE", "ACTIVE", "ACTIVE", "ACTIVE", "ACTIVE",
    "ACTIVE", "ACTIVE", "ACTIVE", "ACTIVE", "ACTIVE",
    "ACTIVE", "ACTIVE", "ACTIVE", "ACTIVE",
    "PENDING", "PENDING", "PENDING",
    "INACTIVE", "INACTIVE",
    "REJECTED",
  ];

  const createdMerchants = [];
  for (let i = 0; i < MERCHANT_SEEDS.length; i++) {
    const seed = MERCHANT_SEEDS[i];
    const status = merchantStatuses[i];
    const [postalCode, city] = pick(POSTALS, i + 3);
    const streetNum = ((i * 11) % 200) + 1;
    const street = pick(STREETS, i * 2);
    const isApprovedOrPaused = status === "ACTIVE" || status === "INACTIVE";
    const joinedAt = addDays(TODAY, -randomInt(45, 180));
    const reviewedAt = status === "PENDING" ? null : addDays(joinedAt, randomInt(1, 5));
    const emailVerifiedAt = status === "PENDING" && i % 3 === 0
      ? null // a few still unverified
      : addDays(joinedAt, randomInt(0, 1));

    const merchant = await prisma.merchant.create({
      data: {
        fundId: fund.id,
        name: seed.name,
        description: seed.description,
        website: seed.website,
        contactName: seed.contact,
        email: `${seed.emailLocal}@${seed.emailDomain}`,
        phone: `+32 2 ${seed.phoneTail}`,
        address: `${streetNum} ${street}`,
        postalCode,
        city,
        country: "BE",
        conditions: seed.conditions,
        status,
        joinedAt,
        reviewedAt,
        reviewerId: reviewedAt ? owner.id : null,
        reviewNote:
          status === "REJECTED"
            ? "Périmètre d'activité hors charte de la caisse — peut être reconsidéré."
            : null,
        emailVerifiedAt,
        citizenPayPlaceId: isApprovedOrPaused
          ? `cp-place-${seed.emailDomain.split(".")[0]}`
          : null,
        citizenPayActivatedAt: isApprovedOrPaused ? addDays(joinedAt, randomInt(2, 8)) : null,
        citizenPayLastSyncedAt: isApprovedOrPaused ? addDays(TODAY, -randomInt(0, 3)) : null,
        applicationData: { businessType: seed.businessType },
        position: i,
      },
    });
    createdMerchants.push(merchant);
  }
  console.log(`[seed-demo] Merchants: ${createdMerchants.length}`);

  // ---------------------------------------------------------------------------
  // 8. Members + cards. Build the full list, then create rows.
  // ---------------------------------------------------------------------------

  type MemberPlan = {
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
    iban: string | null;
    address: { address: string; postalCode: string; city: string };
    householdAdults: number;
    householdChildren: number;
    tierId: string | null;
    tierName: "Solidaire" | "Standard" | "Soutien" | null;
    status: "NEW" | "ACTIVE" | "INACTIVE" | "PAUSED" | "STOPPED" | "REJECTED";
    joinedAt: Date;
    leftAt: Date | null;
    addSecondaryCard: boolean;
  };

  const memberPlans: MemberPlan[] = [];
  // Status distribution (issue #17): 44 ACTIVE, 6 NEW, 4 INACTIVE, 2 PAUSED,
  // 2 STOPPED, 2 REJECTED = 60.
  const statusPlan: MemberPlan["status"][] = [
    ...Array(44).fill("ACTIVE"),
    ...Array(6).fill("NEW"),
    ...Array(4).fill("INACTIVE"),
    ...Array(2).fill("PAUSED"),
    ...Array(2).fill("STOPPED"),
    ...Array(2).fill("REJECTED"),
  ];

  // Active members get a tier assignment. Mix: 14 Solidaire, 20 Standard, 10 Soutien.
  const activeTierPlan: MemberPlan["tierName"][] = [
    ...Array(14).fill("Solidaire"),
    ...Array(20).fill("Standard"),
    ...Array(10).fill("Soutien"),
  ];

  for (let i = 0; i < 60; i++) {
    const first = pick(FIRST_NAMES, i * 13);
    const last = pick(LAST_NAMES, i * 7 + 3);
    const status = statusPlan[i];
    // INACTIVE / PAUSED / STOPPED members were active before, so they keep a
    // tier (historical reports still work). NEW / REJECTED have none yet.
    const onceActive =
      status === "INACTIVE" || status === "PAUSED" || status === "STOPPED";
    let tierName: MemberPlan["tierName"] = null;
    if (status === "ACTIVE") {
      tierName = activeTierPlan[memberPlans.filter((m) => m.status === "ACTIVE").length];
    } else if (onceActive) {
      tierName = i % 3 === 0 ? "Standard" : i % 3 === 1 ? "Solidaire" : "Soutien";
    }

    const joinedAt =
      status === "ACTIVE"
        ? addDays(TODAY, -randomInt(60, 220))
        : onceActive
        ? addDays(TODAY, -randomInt(120, 320))
        : addDays(TODAY, -randomInt(0, 18)); // NEW / REJECTED

    memberPlans.push({
      firstName: first,
      lastName: last,
      email: emailFor(first, last, i),
      phone: i % 4 === 0 ? null : `+32 4${randomInt(70, 99)} ${randomInt(10, 99)} ${randomInt(10, 99)} ${randomInt(10, 99)}`,
      iban: status === "NEW" ? null : generateBelgianIban(),
      address: makeAddress(i),
      householdAdults: i % 5 === 0 ? 1 : 2,
      householdChildren: i % 3 === 0 ? 2 : i % 4 === 0 ? 1 : 0,
      tierId: tierName ? tierByName[tierName].id : null,
      tierName,
      status,
      joinedAt,
      leftAt: status === "STOPPED" ? addDays(joinedAt, randomInt(60, 180)) : null,
      // Roughly 25% of ACTIVE members have a secondary (dependant) card.
      addSecondaryCard: status === "ACTIVE" && i % 4 === 0,
    });
  }

  type CreatedMember = {
    id: string;
    plan: MemberPlan;
    paymentReference: string;
    referralCode: string;
    primaryCardId: string | null;
    primaryCardAccount: string | null;
  };

  const createdMembers: CreatedMember[] = [];

  for (const plan of memberPlans) {
    const paymentReference = generatePaymentReference();
    const referralCode =
      plan.status === "ACTIVE" || plan.status === "INACTIVE"
        ? generateReferralCode()
        : null;

    const member = await prisma.member.create({
      data: {
        fundId: fund.id,
        email: plan.email,
        firstName: plan.firstName,
        lastName: plan.lastName,
        phone: plan.phone,
        iban: plan.iban,
        address: plan.address.address,
        postalCode: plan.address.postalCode,
        city: plan.address.city,
        householdAdults: plan.householdAdults,
        householdChildren: plan.householdChildren,
        tierId: plan.tierId,
        paymentReference,
        referralCode,
        status: plan.status,
        joinedAt: plan.joinedAt,
        leftAt: plan.leftAt,
        emailVerifiedAt:
          plan.status === "NEW"
            ? memberPlans.indexOf(plan) % 3 === 0
              ? null // a few new members still unverified
              : addDays(plan.joinedAt, randomInt(0, 2))
            : addDays(plan.joinedAt, 1),
        applicationData: {
          profession: pick(
            [
              "Enseignant·e",
              "Infirmier·ère",
              "Indépendant·e",
              "Étudiant·e",
              "Pensionné·e",
              "Employé·e administratif·ve",
              "Artisan·e",
              "Aide-soignant·e",
            ],
            memberPlans.indexOf(plan) * 3,
          ),
          heardAboutUs: pick(
            ["friend", "social", "flyer", "press", "other"],
            memberPlans.indexOf(plan),
          ),
          newsletter: memberPlans.indexOf(plan) % 2 === 0 ? "true" : "false",
        },
      },
    });

    let primaryCardId: string | null = null;
    let primaryCardAccount: string | null = null;

    if (
      plan.status === "ACTIVE" ||
      plan.status === "INACTIVE" ||
      plan.status === "PAUSED" ||
      plan.status === "STOPPED"
    ) {
      // These all once had a card. Only ACTIVE cards stay ACTIVE; the rest
      // (inactive / paused / stopped) are BLOCKED.
      const account = generateAccountAddress();
      const issuedAt = addDays(plan.joinedAt, randomInt(2, 10));
      const cardStatus = plan.status === "ACTIVE" ? "ACTIVE" : "BLOCKED";

      const card = await prisma.card.create({
        data: {
          fundId: fund.id,
          memberId: member.id,
          serialNumber: generateCardSerial(),
          account,
          holderName: `${plan.firstName} ${plan.lastName}`,
          status: cardStatus,
          balance: cardStatus === "ACTIVE" ? money(randomInt(20, 350)) : money(0),
          lastTransactionAt:
            cardStatus === "ACTIVE"
              ? addDays(TODAY, -randomInt(0, 14))
              : null,
          issuedAt,
          blockedAt:
            cardStatus === "BLOCKED"
              ? plan.leftAt ?? addDays(plan.joinedAt, randomInt(90, 200))
              : null,
          profileSyncedAt: addDays(TODAY, -randomInt(0, 7)),
        },
      });

      await prisma.member.update({
        where: { id: member.id },
        data: { primaryCardId: card.id },
      });

      primaryCardId = card.id;
      primaryCardAccount = account;

      // Secondary card for ~25% of ACTIVE members.
      if (plan.addSecondaryCard) {
        const dependantFirst = pick(FIRST_NAMES, memberPlans.indexOf(plan) * 5 + 9);
        await prisma.card.create({
          data: {
            fundId: fund.id,
            memberId: member.id,
            serialNumber: generateCardSerial(),
            account: generateAccountAddress(),
            holderName: `${dependantFirst} ${plan.lastName}`,
            status: "ACTIVE",
            balance: money(randomInt(0, 80)),
            lastTransactionAt: addDays(TODAY, -randomInt(1, 21)),
            issuedAt: addDays(issuedAt, randomInt(15, 90)),
            profileSyncedAt: addDays(TODAY, -randomInt(0, 7)),
          },
        });
      }
    }

    createdMembers.push({
      id: member.id,
      plan,
      paymentReference,
      referralCode: referralCode ?? "",
      primaryCardId,
      primaryCardAccount,
    });
  }
  console.log(
    `[seed-demo] Members: ${createdMembers.length} ` +
      `(active=${createdMembers.filter((m) => m.plan.status === "ACTIVE").length}, ` +
      `new=${createdMembers.filter((m) => m.plan.status === "NEW").length}, ` +
      `inactive=${createdMembers.filter((m) => m.plan.status === "INACTIVE").length}, ` +
      `paused=${createdMembers.filter((m) => m.plan.status === "PAUSED").length}, ` +
      `stopped=${createdMembers.filter((m) => m.plan.status === "STOPPED").length}, ` +
      `rejected=${createdMembers.filter((m) => m.plan.status === "REJECTED").length})`,
  );

  // ---------------------------------------------------------------------------
  // 9. Bank transactions (incoming + outgoing) + mints + sources.
  // ---------------------------------------------------------------------------

  let externalCounter = 100_000;
  const nextExtId = () => `cp-tx-${(++externalCounter).toString()}`;

  // 9a. Incoming contributions — one per active member per period.
  //     Closed periods: also create a CONFIRMED MINT + TokenOperationSource.
  //     Open period (May): a deposit but no mint yet (accumulating).
  //
  //     A handful of edge cases for realism:
  //     - 1 member has a deposit slightly OUTSIDE their tier range → unmatched
  //     - 1 member's Apr deposit triggered a FAILED mint
  //     - 1 member's recent Apr deposit triggered a PENDING mint (retry in flight)

  const activeMembers = createdMembers.filter((m) => m.plan.status === "ACTIVE");
  let mintCreatedCount = 0;
  let bankTxCreatedCount = 0;

  for (let mi = 0; mi < activeMembers.length; mi++) {
    const m = activeMembers[mi];
    if (!m.plan.tierName) continue;
    const tier = tierByName[m.plan.tierName];
    const minC = Number(tier.minContribution);
    const maxC = Number(tier.maxContribution);

    for (const period of periods) {
      // Only members who joined before the period's cutoff contribute.
      if (m.plan.joinedAt > period.cutoffDate) continue;

      // ~85% of active members contribute in the open (May) period so far.
      if (period.label === "2026-05" && mi % 7 === 0) continue;

      const dayInPeriod = period.startsAt;
      // Spread deposits across the month: 1st-23rd.
      const occurredAt = addDays(dayInPeriod, randomInt(0, 22));

      // One member's Apr deposit is slightly out of range → unmatched.
      const isUnmatched = mi === 3 && period.label === "2026-04";
      const amount = isUnmatched
        ? maxC + randomInt(50, 80) // way above their tier band
        : randomInt(Math.ceil(minC), Math.floor(maxC));

      const tx = await prisma.bankTransaction.create({
        data: {
          fundId: fund.id,
          externalId: nextExtId(),
          direction: "INCOMING",
          amount: money(amount),
          currency: "EUR",
          occurredAt,
          counterpartName: `${m.plan.firstName.toUpperCase()} ${m.plan.lastName.toUpperCase()}`,
          counterpartIban: m.plan.iban,
          counterpartReference: m.paymentReference,
          remittanceInfo: `Versement caisse ${period.label}`,
          memberId: isUnmatched ? null : m.id,
          allocationPeriodId: isUnmatched ? null : period.id,
          matchedAt: isUnmatched ? null : addDays(occurredAt, 1),
          notes: isUnmatched
            ? "Montant hors palier — à reclasser avec le membre."
            : null,
        },
      });
      bankTxCreatedCount++;

      if (isUnmatched) continue;

      // For closed periods, mint the tier's allocation amount.
      if (period.status === "CLOSED" && m.primaryCardAccount) {
        // Status: mostly CONFIRMED, plus the edge cases above.
        let opStatus: "PENDING" | "CONFIRMED" | "FAILED" = "CONFIRMED";
        let errorMessage: string | null = null;
        let txHash: string | null = generateTxHash();
        let confirmedAt: Date | null = period.closedAt
          ? addDays(period.closedAt, randomInt(1, 4))
          : null;

        // Apr edge cases.
        if (period.label === "2026-04") {
          if (mi === 7) {
            opStatus = "FAILED";
            errorMessage = "CitizenPay: insufficient gas for batch settlement";
            txHash = null;
            confirmedAt = null;
          } else if (mi === 12) {
            opStatus = "PENDING";
            txHash = null;
            confirmedAt = null;
          }
        }

        const op = await prisma.tokenOperation.create({
          data: {
            fundId: fund.id,
            type: "MINT",
            memberId: m.id,
            account: m.primaryCardAccount,
            amount: tier.allocationAmount,
            tierId: tier.id,
            allocationPeriodId: period.id,
            status: opStatus,
            txHash,
            errorMessage,
            submittedAt: period.closedAt
              ? addDays(period.closedAt, randomInt(0, 1))
              : new Date(),
            confirmedAt,
          },
        });
        mintCreatedCount++;

        await prisma.tokenOperationSource.create({
          data: {
            bankTransactionId: tx.id,
            tokenOperationId: op.id,
            // Full deposit attributed to this op.
            attributedAmount: null,
          },
        });
      }
    }
  }
  console.log(`[seed-demo] Incoming bank transactions: ~${bankTxCreatedCount} (mints: ${mintCreatedCount})`);

  // 9b. Outgoing — payouts to active merchants. ~3 per month per merchant.
  const activeMerchants = createdMerchants.filter((m) => m.status === "ACTIVE");
  let outCount = 0;
  for (const period of periods) {
    for (const merchant of activeMerchants) {
      const payoutsThisMonth = period.label === "2026-05" ? randomInt(0, 2) : randomInt(2, 4);
      for (let p = 0; p < payoutsThisMonth; p++) {
        const occurredAt = addDays(period.startsAt, randomInt(2, 26));
        // Don't create OUTGOINGs dated after "today" for the open period.
        if (occurredAt > TODAY) continue;
        const amount = randomInt(45, 420) + Math.random();
        await prisma.bankTransaction.create({
          data: {
            fundId: fund.id,
            externalId: nextExtId(),
            direction: "OUTGOING",
            amount: money(amount),
            currency: "EUR",
            occurredAt,
            counterpartName: merchant.name,
            counterpartIban: generateBelgianIban(),
            counterpartReference: `PAY-${merchant.id.slice(-6).toUpperCase()}-${period.label}`,
            remittanceInfo: `Paiement commerçants ${period.label}`,
            merchantId: merchant.id,
            allocationPeriodId: null,
            matchedAt: addDays(occurredAt, 1),
          },
        });
        outCount++;
      }
    }
  }
  console.log(`[seed-demo] Outgoing bank transactions: ${outCount}`);

  // ---------------------------------------------------------------------------
  // 10. Referrals — 6 ACTIVATED (with reward MINT) + 2 PENDING.
  // ---------------------------------------------------------------------------

  const sponsorsPool = activeMembers.filter((m) => m.referralCode && m.primaryCardAccount);
  const refereesActivePool = activeMembers
    .filter((m) => m.plan.joinedAt > addDays(TODAY, -90)) // recently joined
    .slice(0, 6);
  const refereesPendingPool = createdMembers
    .filter((m) => m.plan.status === "NEW")
    .slice(0, 2);

  let refsActivated = 0;
  for (let i = 0; i < refereesActivePool.length; i++) {
    const sponsor = sponsorsPool[i % sponsorsPool.length];
    const referee = refereesActivePool[i];
    if (!sponsor || !referee || sponsor.id === referee.id) continue;

    // Reward MINT (CONFIRMED) that paid out the bonus.
    const rewardOp = await prisma.tokenOperation.create({
      data: {
        fundId: fund.id,
        type: "MINT",
        memberId: sponsor.id,
        account: sponsor.primaryCardAccount!,
        amount: money(25),
        status: "CONFIRMED",
        txHash: generateTxHash(),
        submittedAt: addDays(referee.plan.joinedAt, randomInt(2, 8)),
        confirmedAt: addDays(referee.plan.joinedAt, randomInt(3, 10)),
      },
    });
    await prisma.referral.create({
      data: {
        fundId: fund.id,
        sponsorId: sponsor.id,
        refereeId: referee.id,
        codeUsed: sponsor.referralCode,
        status: "ACTIVATED",
        activatedAt: addDays(referee.plan.joinedAt, randomInt(2, 8)),
        rewardOperationId: rewardOp.id,
      },
    });
    refsActivated++;
  }

  let refsPending = 0;
  for (let i = 0; i < refereesPendingPool.length; i++) {
    const sponsor = sponsorsPool[(i + 3) % sponsorsPool.length];
    const referee = refereesPendingPool[i];
    if (!sponsor || !referee) continue;
    await prisma.referral.create({
      data: {
        fundId: fund.id,
        sponsorId: sponsor.id,
        refereeId: referee.id,
        codeUsed: sponsor.referralCode,
        status: "PENDING",
      },
    });
    refsPending++;
  }
  console.log(`[seed-demo] Referrals: ${refsActivated} activated + ${refsPending} pending`);

  // ---------------------------------------------------------------------------
  // 11. Emails — sample of each kind to populate the email log/outbox.
  // ---------------------------------------------------------------------------

  const emailSamples: Array<{
    type:
      | "MEMBER_EMAIL_VERIFICATION"
      | "MEMBER_WELCOME"
      | "MEMBER_ACTIVATED"
      | "PAYMENT_CONFIRMATION"
      | "ALLOCATION_CONFIRMATION"
      | "PAYMENT_REMINDER_FIRST"
      | "PAYMENT_REMINDER_SECOND"
      | "PAYMENT_FORGOTTEN"
      | "MERCHANT_WELCOME"
      | "MERCHANT_APPROVED"
      | "REFERRAL_BONUS_AWARDED";
    targetMember?: CreatedMember;
    targetMerchant?: (typeof createdMerchants)[number];
    subject: string;
    status: "SENT" | "QUEUED" | "FAILED";
    daysAgo: number;
  }> = [];

  // Welcome for some ACTIVE members.
  for (const m of activeMembers.slice(0, 8)) {
    emailSamples.push({
      type: "MEMBER_WELCOME",
      targetMember: m,
      subject: `Bienvenue à la ${FUND_NAME}`,
      status: "SENT",
      daysAgo: Math.floor((TODAY.getTime() - m.plan.joinedAt.getTime()) / 86_400_000) - 1,
    });
  }
  // Verification for some NEW members.
  for (const m of createdMembers.filter((m) => m.plan.status === "NEW").slice(0, 4)) {
    emailSamples.push({
      type: "MEMBER_EMAIL_VERIFICATION",
      targetMember: m,
      subject: `Confirmez votre adresse e-mail`,
      status: "SENT",
      daysAgo: Math.floor((TODAY.getTime() - m.plan.joinedAt.getTime()) / 86_400_000),
    });
  }
  // Activation emails for some ACTIVE members.
  for (const m of activeMembers.slice(0, 6)) {
    emailSamples.push({
      type: "MEMBER_ACTIVATED",
      targetMember: m,
      subject: `Votre carte est activée — bienvenue !`,
      status: "SENT",
      daysAgo: Math.floor((TODAY.getTime() - m.plan.joinedAt.getTime()) / 86_400_000) - 3,
    });
  }
  // Payment reminders for May (current open period) — first wave.
  for (const m of activeMembers.slice(40, 44)) {
    emailSamples.push({
      type: "PAYMENT_REMINDER_FIRST",
      targetMember: m,
      subject: `Rappel — votre versement pour mai`,
      status: "SENT",
      daysAgo: 3,
    });
  }
  // Allocation confirmation emails for April closed mints.
  for (const m of activeMembers.slice(0, 8)) {
    emailSamples.push({
      type: "ALLOCATION_CONFIRMATION",
      targetMember: m,
      subject: `Vos solidaires d'avril sont disponibles`,
      status: "SENT",
      daysAgo: 13,
    });
  }
  // Payment confirmation for a few April deposits.
  for (const m of activeMembers.slice(5, 11)) {
    emailSamples.push({
      type: "PAYMENT_CONFIRMATION",
      targetMember: m,
      subject: `Versement reçu — merci`,
      status: "SENT",
      daysAgo: 20,
    });
  }
  // Merchant welcome / approvals.
  for (const merch of activeMerchants.slice(0, 4)) {
    emailSamples.push({
      type: "MERCHANT_WELCOME",
      targetMerchant: merch,
      subject: `Bienvenue dans le réseau de la ${FUND_NAME}`,
      status: "SENT",
      daysAgo: Math.floor((TODAY.getTime() - merch.joinedAt.getTime()) / 86_400_000),
    });
    emailSamples.push({
      type: "MERCHANT_APPROVED",
      targetMerchant: merch,
      subject: `Votre commerce a été approuvé`,
      status: "SENT",
      daysAgo: Math.floor((TODAY.getTime() - merch.joinedAt.getTime()) / 86_400_000) - 2,
    });
  }
  // Referral bonus awarded.
  for (const m of sponsorsPool.slice(0, 4)) {
    emailSamples.push({
      type: "REFERRAL_BONUS_AWARDED",
      targetMember: m,
      subject: `Vous avez parrainé un nouveau membre — bravo !`,
      status: "SENT",
      daysAgo: 8,
    });
  }
  // A couple of queued + one failed for variety.
  emailSamples.push({
    type: "PAYMENT_REMINDER_SECOND",
    targetMember: activeMembers[20],
    subject: `Second rappel — versement de mai`,
    status: "QUEUED",
    daysAgo: 0,
  });
  emailSamples.push({
    type: "PAYMENT_FORGOTTEN",
    targetMember: activeMembers[21],
    subject: `Vous avez oublié votre versement de mars`,
    status: "FAILED",
    daysAgo: 5,
  });

  let emailCount = 0;
  for (let i = 0; i < emailSamples.length; i++) {
    const e = emailSamples[i];
    const target = e.targetMember ?? e.targetMerchant!;
    const sentAt = e.status === "SENT" ? addDays(TODAY, -e.daysAgo) : null;
    const failedAt = e.status === "FAILED" ? addDays(TODAY, -e.daysAgo) : null;
    // Idempotency keys must be globally unique — pad with a counter for samples
    // that could otherwise collide.
    const idemKey = e.targetMember
      ? `${e.type}:member:${e.targetMember.id}:sample:${i}`
      : `${e.type}:merchant:${e.targetMerchant!.id}:sample:${i}`;
    await prisma.email.create({
      data: {
        fundId: fund.id,
        type: e.type,
        toEmail: e.targetMember?.plan.email ?? e.targetMerchant?.email ?? "demo@example.com",
        memberId: e.targetMember?.id ?? null,
        merchantId: e.targetMerchant?.id ?? null,
        idempotencyKey: idemKey,
        subject: e.subject,
        status: e.status,
        sentAt,
        failedAt,
        resendMessageId: e.status === "SENT" ? `re-${randomBytes(8).toString("hex")}` : null,
        errorMessage:
          e.status === "FAILED" ? "Resend: recipient mailbox does not exist" : null,
      },
    });
    emailCount++;
    void target; // appease unused-var lint
  }
  console.log(`[seed-demo] Emails: ${emailCount}`);

  // ---------------------------------------------------------------------------
  // Done.
  // ---------------------------------------------------------------------------

  void periodByLabel;
  void closedPeriods;
  void openPeriod;

  console.log(
    `\n✓ Demo seed complete.\n` +
      `  Login at https://auth.${process.env.APP_DOMAIN ?? "lacaisse.eu"}/login as ${OWNER_EMAIL}.\n` +
      `  Visit https://${FUND_DOMAIN}/dashboard\n`,
  );
}

main()
  .catch((err) => {
    console.error("\n✗ seed-demo failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
