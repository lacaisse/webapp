// SPDX-License-Identifier: AGPL-3.0-or-later

// Turns a fund's OnboardingStep + OnboardingField rows into the ordered pages
// the public signup form renders.
//
// The invariant that matters: EVERY active field lands on exactly one page. A
// field can point at a step that was archived after the field was assigned (we
// deliberately don't cascade), and most funds have no steps at all — both cases
// fall back to the first page rather than dropping the input from the form.
//
// Built-ins are not part of this grouping: identity (first/last name, email)
// always leads on page 1 and the commitment amount / reminder opt-out always
// close the last page. Only the per-fund extras are distributed.
//
// Pure module (no Prisma, no server-only) so it can be unit-tested and imported
// from both the server page and the client form.

export type StepDef = {
  id: string;
  title: string;
  description: string | null;
  position: number;
};

export type FieldWithStep = {
  key: string;
  position: number;
  stepId: string | null;
};

export type FormStep<F> = {
  // null on the implicit single page — the form then renders no step header.
  id: string | null;
  title: string | null;
  description: string | null;
  fields: F[];
};

export function buildFormSteps<F extends FieldWithStep>(
  steps: StepDef[],
  fields: F[],
): FormStep<F>[] {
  const ordered = [...fields].sort((a, b) => a.position - b.position);

  // No steps configured → the classic single-page form.
  if (steps.length === 0) {
    return [{ id: null, title: null, description: null, fields: ordered }];
  }

  const sortedSteps = [...steps].sort((a, b) => a.position - b.position);
  const known = new Set(sortedSteps.map((s) => s.id));
  const firstId = sortedSteps[0].id;

  const byStep = new Map<string, F[]>(sortedSteps.map((s) => [s.id, []]));
  for (const field of ordered) {
    // Unassigned, or assigned to a step that no longer exists / was archived.
    const target =
      field.stepId && known.has(field.stepId) ? field.stepId : firstId;
    byStep.get(target)!.push(field);
  }

  return sortedSteps.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    fields: byStep.get(s.id)!,
  }));
}
