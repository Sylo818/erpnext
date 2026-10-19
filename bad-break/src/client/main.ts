import "./ui/style.css";

async function boot() {
  const canvas = document.getElementById("game") as HTMLCanvasElement;
  const q = new URLSearchParams(location.search);
  if (q.has("lab")) {
    const { startLab } = await import("./lab");
    await startLab(canvas);
    return;
  }
  document.getElementById("ui")!.textContent = "BAD BREAK (menu coming up)";
}
boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#f66;position:fixed;top:0;left:0;padding:12px;z-index:9">${String(e?.stack ?? e)}</pre>`);
});
