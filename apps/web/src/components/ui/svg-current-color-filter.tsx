/** External images cannot inherit currentColor; recolor their alpha without a CORS mask fetch. */
export function SvgCurrentColorFilter({ id }: { readonly id: string }) {
  return (
    <filter id={id} colorInterpolationFilters="sRGB">
      <feFlood floodColor="currentColor" />
      <feComposite in2="SourceAlpha" operator="in" />
    </filter>
  );
}
