export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const escHtml = escapeHtml;

export function formatNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

export function formatK(value) {
  return `${(Number(value || 0) / 1000).toFixed(1)}k`;
}

export function formatTokens(value) {
  const number = Number(value || 0);
  const absolute = Math.abs(number);
  if (absolute >= 1e12) return `${(number / 1e12).toFixed(1)}T`;
  if (absolute >= 1e9) return `${(number / 1e9).toFixed(1)}B`;
  if (absolute >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
  if (absolute >= 1e3) return `${(number / 1e3).toFixed(1)}k`;
  return String(Math.round(number));
}

export function formatCost(value) {
  return Number(value || 0).toFixed(2);
}
