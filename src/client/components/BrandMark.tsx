/**
 * FireOS のロゴマーク：濃紺の角丸に、同心円2つと中心の橙の点（prototypeのヘッダー/ログインのマーク）。
 * 寸法比は prototype の 32px（リング19/12・点4〜5）と 76px（リング46/28・点10）から導いた比率。
 */
export function BrandMark({ size = 32 }: { size?: number }) {
  const ring = (ratio: number, alpha: number) => ({
    position: "absolute" as const,
    width: size * ratio,
    height: size * ratio,
    borderRadius: "50%",
    boxShadow: `inset 0 0 0 ${size >= 60 ? 1.5 : 1}px rgba(255,106,61,${alpha})`,
  });
  return (
    <span
      aria-hidden="true"
      style={{
        position: "relative",
        flex: "none",
        width: size,
        height: size,
        borderRadius: size * 0.3125,
        background: "linear-gradient(180deg,#16223a,#0c1526)",
        boxShadow:
          size >= 60
            ? "inset 0 0 0 1px rgba(255,255,255,.1),0 20px 40px -12px rgba(0,0,0,.7)"
            : "inset 0 0 0 1px rgba(255,255,255,.12)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <span style={ring(0.6, size >= 60 ? 0.22 : 0.25)} />
      <span style={ring(0.37, size >= 60 ? 0.5 : 0.55)} />
      <span
        style={{
          width: size * 0.135,
          height: size * 0.135,
          borderRadius: "50%",
          background: "#ff5a2e",
          boxShadow: `0 0 ${size >= 60 ? 14 : 8}px rgba(255,90,46,.9)`,
        }}
      />
    </span>
  );
}
