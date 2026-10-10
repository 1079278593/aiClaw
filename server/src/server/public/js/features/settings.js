import { readStorage, storageKey, writeStorage } from "../brand.js";

const THEMES = new Set(["light", "daylight", "monochrome"]);
const SHOW_PROCESS_STORAGE_KEY = storageKey("show-process-enabled");

const FONT_MAP = {
  system: "system-ui, -apple-system, sans-serif",
  kaiti: '"KaiTi", "STKaiti", "AR PL UKai CN", serif',
  simsun: '"SimSun", "STSong", "Noto Serif CJK SC", serif',
};

export function initSettings() {
  const updateThemeActive = () => {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    document.querySelectorAll(".settings-option[data-theme]").forEach((element) => {
      element.classList.toggle("active", element.dataset.theme === current);
    });
  };
  const setTheme = (theme) => {
    const selectedTheme = THEMES.has(theme) ? theme : "light";
    document.documentElement.setAttribute("data-theme", selectedTheme);
    writeStorage("theme", selectedTheme);
    updateThemeActive();
  };
  setTheme(readStorage("theme") || "light");

  const updateFontActive = () => {
    const current = readStorage("font") || "system";
    document.querySelectorAll(".settings-option[data-font]").forEach((element) => {
      element.classList.toggle("active", element.dataset.font === current);
    });
  };
  const setFont = (font) => {
    document.documentElement.style.setProperty("--md-font-family", FONT_MAP[font] || FONT_MAP.system);
    writeStorage("font", font);
    updateFontActive();
  };
  setFont(readStorage("font") || "system");

  const setFontSize = (size) => {
    document.documentElement.style.setProperty("--md-font-size", size + "px");
    writeStorage("font-size", String(size));
    const label = document.getElementById("font-size-label");
    if (label) label.textContent = size + "px";
  };
  const size = Number(readStorage("font-size") || 15);
  const slider = document.getElementById("font-size-slider");
  if (slider) {
    slider.value = size;
    slider.addEventListener("input", () => setFontSize(Number(slider.value)));
  }
  setFontSize(size);

  const setShowProcess = (showProcess) => {
    document.documentElement.dataset.showProcess = String(showProcess);
    if (showProcess) localStorage.setItem(SHOW_PROCESS_STORAGE_KEY, "true");
    else localStorage.removeItem(SHOW_PROCESS_STORAGE_KEY);
    const checkbox = document.getElementById("show-process-checkbox");
    if (checkbox) checkbox.checked = showProcess;
  };
  setShowProcess(localStorage.getItem(SHOW_PROCESS_STORAGE_KEY) === "true");
  document.getElementById("show-process-checkbox")?.addEventListener("change", (event) => {
    setShowProcess(event.currentTarget.checked);
  });

  const dropdown = document.getElementById("settings-dropdown");
  document.getElementById("settings-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    dropdown?.classList.toggle("open");
  });
  document.querySelectorAll(".settings-option[data-theme]").forEach((element) => {
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      setTheme(element.dataset.theme);
    });
  });
  document.querySelectorAll(".settings-option[data-font]").forEach((element) => {
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      setFont(element.dataset.font);
    });
  });
  document.addEventListener("click", (event) => {
    const settings = document.getElementById("sidebar-settings");
    if (settings && !settings.contains(event.target)) dropdown?.classList.remove("open");
  });
}
