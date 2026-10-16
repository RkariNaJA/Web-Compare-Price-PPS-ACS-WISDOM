/**
 * Small database (cylinder) icon used in the setup card's source headers.
 * Strokes in currentColor so each card tints it with its source colour.
 */
export default function DbIcon() {
  return (
    <svg className="db-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <ellipse cx="12" cy="5.5" rx="7" ry="2.8" />
        <path d="M5 5.5v13c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8v-13" />
        <path d="M5 12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8" />
      </g>
    </svg>
  );
}
