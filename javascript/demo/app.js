const form = document.querySelector("#audit-form");
const mode = document.querySelector("#mode"),
  first = document.querySelector("#first"),
  second = document.querySelector("#second");
const status = document.querySelector("#status"),
  submit = document.querySelector("#audit-submit"),
  cancel = document.querySelector("#cancel");
const result = document.querySelector("#result"),
  preview = document.querySelector("#preview");
let controller,
  generation = 0,
  urls = [];
let maxFileBytes = 25 * 1024 * 1024;
void fetch("/limits")
  .then((response) => response.json())
  .then((limits) => {
    maxFileBytes = limits.maxFileBytes;
    document.querySelector("#requirements").textContent =
      `MP3, WAV, M4A, AAC, FLAC, OGG, Opus or WebM · Up to ${(limits.maxFileBytes / 1048576).toFixed(0)} MiB per file · Up to ${(limits.maxDurationSeconds / 60).toFixed(1)} minutes · One audio track`;
  })
  .catch(() => {});
function clearReport() {
  for (const url of urls) URL.revokeObjectURL(url);
  urls = [];
  result.hidden = true;
  preview.srcdoc = "";
  const audio = document.querySelector("#processed-audio");
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  audio.hidden = true;
  document.querySelector("#processed-summary").hidden = true;
  document.querySelector("#download-audio").hidden = true;
}
function idle() {
  submit.disabled = false;
  first.disabled = false;
  second.disabled = false;
  mode.disabled = false;
  cancel.hidden = true;
}
function reset() {
  generation++;
  controller?.abort();
  controller = undefined;
  idle();
  clearReport();
  form.reset();
  update();
  status.textContent = "Ready.";
}
function update() {
  const compare = mode.value === "compare";
  document.querySelector("#second-wrap").hidden = !compare;
  second.required = compare;
  document.querySelector("#first-label").textContent = compare
    ? "Original file"
    : "Audio file";
  document.querySelector("#policy-note").hidden = mode.value !== "validate";
  submit.textContent = compare
    ? "Compare audio"
    : mode.value === "validate"
      ? "Check audio"
      : mode.value === "enhance"
        ? "Enhance audio"
        : mode.value === "denoise"
          ? "Remove noise"
          : "Analyze audio";
}
async function execute(exampleFile) {
  if (controller) return;
  const id = ++generation;
  controller = new AbortController();
  const signal = controller.signal;
  clearReport();
  const selected = exampleFile || first.files[0];
  const other = second.files[0];
  if (
    !selected ||
    selected.size > maxFileBytes ||
    (mode.value === "compare" && (!other || other.size > maxFileBytes))
  ) {
    controller = undefined;
    status.textContent =
      "Choose the required files within the displayed upload limit.";
    return;
  }
  const data = new FormData();
  data.append(mode.value === "compare" ? "before" : "audio", selected);
  if (mode.value === "compare") data.append("after", other);
  submit.disabled = true;
  first.disabled = true;
  second.disabled = true;
  mode.disabled = true;
  cancel.hidden = false;
  const processing = ["enhance", "denoise"].includes(mode.value);
  status.textContent = processing ? "Processing audio…" : "Analyzing audio…";
  try {
    const response = await fetch("/api/" + mode.value, {
      method: "POST",
      headers: { "X-Audio-Audit": "1" },
      body: data,
      signal,
    });
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.error || "Processing could not finish.");
    }
    if (processing) {
      const blob = await response.blob();
      if (id !== generation) return;
      const report = JSON.parse(atob(response.headers.get("X-Audio-Report")));
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const audio = document.querySelector("#processed-audio");
      audio.src = url;
      audio.hidden = false;
      const download = document.querySelector("#download-audio");
      download.href = url;
      download.hidden = false;
      const summary = document.querySelector("#processed-summary");
      summary.textContent = `${report.durationSeconds.toFixed(2)} seconds · ${report.sampleRate} Hz · ${report.channels} channel(s) · ${report.integratedLufs ?? "Unmeasurable"} LUFS${report.warnings.length ? " · " + report.warnings.join(" ") : ""}`;
      summary.hidden = false;
      const jsonUrl = URL.createObjectURL(
        new Blob([JSON.stringify(report, null, 2)], {
          type: "application/json",
        }),
      );
      urls.push(jsonUrl);
      document.querySelector("#download-json").href = jsonUrl;
      document.querySelector("#download-html").hidden = true;
      preview.hidden = true;
      result.hidden = false;
      status.textContent = "Your processed audio is ready.";
      return;
    }
    const body = await response.json();
    if (id !== generation) return;
    preview.srcdoc = body.html;
    preview.hidden = false;
    document.querySelector("#download-html").hidden = false;
    result.hidden = false;
    for (const [selector, content, type] of [
      [
        "#download-json",
        JSON.stringify(body.report, null, 2),
        "application/json",
      ],
      ["#download-html", body.html, "text/html"],
    ]) {
      const url = URL.createObjectURL(new Blob([content], { type }));
      urls.push(url);
      document.querySelector(selector).href = url;
    }
    status.textContent = "Analysis complete.";
  } catch (e) {
    if (id === generation)
      status.textContent = e.name === "AbortError" ? "Cancelled." : e.message;
  } finally {
    if (id === generation) {
      controller = undefined;
      idle();
    }
  }
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void execute();
});
mode.addEventListener("change", update);
cancel.addEventListener("click", () => controller?.abort());
document.querySelector("#audit-reset").addEventListener("click", reset);
document.querySelector("#example").addEventListener("click", async () => {
  if (controller) return;
  const id = generation;
  try {
    const response = await fetch("/speech-example.wav");
    if (!response.ok) throw Error("The example is unavailable.");
    const blob = await response.blob();
    if (id !== generation || controller) return;
    mode.value = "enhance";
    update();
    await execute(
      new File([blob], "noisy-speech-example.wav", { type: "audio/wav" }),
    );
  } catch (e) {
    status.textContent = e.message;
  }
});
window.addEventListener("pagehide", () => {
  controller?.abort();
  clearReport();
});
update();
