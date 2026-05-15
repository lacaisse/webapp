// SPDX-License-Identifier: AGPL-3.0-or-later
export function PolicySection({
  heading,
  body,
  intro,
  items,
  note,
  contact,
}: {
  heading: string;
  body?: string;
  intro?: string;
  items?: string[];
  note?: string;
  contact?: string;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold tracking-tight">{heading}</h2>
      {body ? (
        <p className="text-sm leading-relaxed">{body}</p>
      ) : null}
      {intro ? (
        <p className="text-sm leading-relaxed">{intro}</p>
      ) : null}
      {items ? (
        <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed marker:text-muted-foreground">
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      ) : null}
      {note ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{note}</p>
      ) : null}
      {contact ? (
        <p className="text-sm leading-relaxed">{contact}</p>
      ) : null}
    </section>
  );
}
