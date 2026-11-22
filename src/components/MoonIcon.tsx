export function MoonIcon({ size = 120, glow = false }: { size?: number; glow?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      style={glow ? { filter: "drop-shadow(0 0 18px rgba(190,200,255,0.55))" } : undefined}
    >
      <defs>
        <linearGradient id="moonfill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f4f6ff" />
          <stop offset="1" stopColor="#9aa6e8" />
        </linearGradient>
      </defs>
      <path
        d="M62 10 A40 40 0 1 0 90 66 A32 32 0 1 1 62 10 Z"
        fill="url(#moonfill)"
      />
    </svg>
  );
}
