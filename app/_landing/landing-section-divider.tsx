export function SectionDivider({ id, label }: { id: string; label: string }) {
  return (
    <div
      id={id}
      className="mx-auto w-full max-w-[1240px] px-8 pb-6 pt-16 max-[760px]:px-5"
      style={{ scrollMarginTop: 80 }}
    >
      <div className="flex items-center gap-3.5">
        <span className="lp-dot" />
        <span
          className="lp-eyebrow shrink-0"
          style={{ whiteSpace: "nowrap" }}
        >
          {label}
        </span>
        <hr
          className="m-0 flex-1 border-0 border-t"
          style={{ borderColor: "var(--border)" }}
        />
      </div>
    </div>
  );
}
