/* 全屏图片预览（lightbox）：单例浮层，点击任意处或按 Esc 关闭。
   图片 src 由调用方传入（剪贴板 data URL / 会话历史中的 image_url.url）。 */

let lightboxEl = null;
let lightboxImg = null;
let lightboxCaption = null;

function ensureLightbox() {
  if (lightboxEl) return;
  lightboxEl = document.createElement("div");
  lightboxEl.className = "image-lightbox";
  lightboxEl.setAttribute("role", "dialog");
  lightboxEl.setAttribute("aria-modal", "true");
  lightboxEl.setAttribute("aria-label", "图片预览");
  lightboxImg = document.createElement("img");
  lightboxImg.className = "image-lightbox-img";
  lightboxImg.alt = "图片预览";
  lightboxCaption = document.createElement("div");
  lightboxCaption.className = "image-lightbox-caption";
  lightboxEl.append(lightboxImg, lightboxCaption);
  lightboxEl.addEventListener("click", closeImagePreview);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && lightboxEl.classList.contains("open")) {
      event.preventDefault();
      closeImagePreview();
    }
  });
  document.body.appendChild(lightboxEl);
}

export function openImagePreview(url, caption) {
  if (!url) return;
  ensureLightbox();
  lightboxImg.src = url;
  const label = caption || "";
  lightboxCaption.textContent = label;
  lightboxCaption.style.display = label ? "" : "none";
  lightboxEl.classList.add("open");
}

export function closeImagePreview() {
  if (!lightboxEl?.classList.contains("open")) return;
  lightboxEl.classList.remove("open");
  // 关闭后释放 src，避免大体积 data URL 常驻内存
  requestAnimationFrame(() => {
    if (!lightboxEl.classList.contains("open")) lightboxImg.removeAttribute("src");
  });
}
