// Arra mark: two arches (the double A) meeting in a keystone. A promise held up by collateral.
export default function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M4 27V15a8 8 0 0 1 16 0v12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M12 27V15a8 8 0 0 1 16 0v12" fill="none" stroke="var(--seal)" strokeWidth="2.4" strokeLinecap="round" />
      <rect x="14.6" y="5.2" width="2.8" height="4.2" rx="1" fill="currentColor" />
    </svg>
  );
}
