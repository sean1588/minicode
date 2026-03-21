// Shared utilities for web frontend

/** HTML-escape a string using the DOM's built-in encoding. */
export function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
