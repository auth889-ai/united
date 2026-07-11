// Shareable session card — renders a social-media-ready PNG on a canvas
// and downloads it. Gamification/virality: athletes share their numbers.

export function downloadShareCard(session) {
  const W = 840, H = 440;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");

  // background + frame
  x.fillStyle = "#0b0e13";
  x.fillRect(0, 0, W, H);
  const glow = x.createRadialGradient(W * 0.85, 0, 0, W * 0.85, 0, 500);
  glow.addColorStop(0, "rgba(163,230,53,0.15)");
  glow.addColorStop(1, "rgba(163,230,53,0)");
  x.fillStyle = glow;
  x.fillRect(0, 0, W, H);
  x.strokeStyle = "rgba(163,230,53,0.4)";
  x.lineWidth = 3;
  x.strokeRect(10, 10, W - 20, H - 20);

  // brand
  x.fillStyle = "#a3e635";
  x.font = "800 26px 'Space Grotesk', system-ui, sans-serif";
  x.fillText("FORMCOACH AI", 48, 70);
  x.fillStyle = "#8a939d";
  x.font = "500 17px system-ui, sans-serif";
  x.fillText("session card · " + session.shortDate, 48, 98);

  // exercise
  x.fillStyle = "#f4f6f8";
  x.font = "700 52px 'Space Grotesk', system-ui, sans-serif";
  x.fillText(session.exercise.toUpperCase(), 48, 175);

  // stats
  const stats = [
    [String(session.reps), session.exercise === "Vertical jump" ? "jumps" : "reps"],
    [String(session.avgScore), "form score"],
  ];
  if (session.bestJumpCm) stats.push([session.bestJumpCm + "cm", "best jump"]);
  let sx = 48;
  for (const [v, label] of stats) {
    x.fillStyle = "#a3e635";
    x.font = "800 64px 'Space Grotesk', system-ui, sans-serif";
    x.fillText(v, sx, 290);
    const w = x.measureText(v).width;
    x.fillStyle = "#8a939d";
    x.font = "500 18px system-ui, sans-serif";
    x.fillText(label, sx, 320);
    sx += Math.max(w, x.measureText(label).width) + 56;
  }

  // footer
  x.fillStyle = "#b7c0ca";
  x.font = "500 18px system-ui, sans-serif";
  x.fillText("Coached by AI. Verified by my webcam. 💪", 48, 380);
  x.fillStyle = "#65a30d";
  x.fillText("auth889-ai.github.io/united", 48, 408);

  const a = document.createElement("a");
  a.download = `formcoach-${session.exercise.toLowerCase().replace(/\s+/g, "-")}-${session.shortDate.replace(/\s+/g, "")}.png`;
  a.href = c.toDataURL("image/png");
  a.click();
}
