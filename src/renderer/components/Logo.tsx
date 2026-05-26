interface LogoProps {
  /** 边长(像素),图标为正方形 */
  size?: number;
  className?: string;
}

/**
 * Workspace Agent 品牌标识(WA 字母组合)。
 * W 笔画顶点收成 A 的尖 = Workspace Agent,琥珀点点睛。
 * 内联 SVG,不依赖外部资源路径,渲染清晰且与主题无关。
 */
export function Logo({ size = 80, className }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Workspace Agent"
    >
      <defs>
        <linearGradient
          id="wa-logo-grad"
          x1="56"
          y1="80"
          x2="200"
          y2="180"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#6366f1" />
          <stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
      {/* 圆角方块底:工作区 */}
      <rect x="32" y="32" width="192" height="192" rx="44" fill="#1e1e2e" />
      <rect
        x="33"
        y="33"
        width="190"
        height="190"
        rx="43"
        stroke="#312e6e"
        strokeWidth="2"
      />
      {/* W 形:两个 V 笔画,顶点向上收成 A 的尖 */}
      <path
        d="M72 86 L98 170 L128 110 L158 170 L184 86"
        stroke="url(#wa-logo-grad)"
        strokeWidth="18"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* A 顶点琥珀火花 */}
      <circle cx="128" cy="92" r="11" fill="#f59e0b" />
    </svg>
  );
}
