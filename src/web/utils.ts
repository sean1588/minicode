// Shared utilities for web frontend

import { marked } from 'marked';

declare const hljs: { highlightElement(el: HTMLElement): void; getLanguage(lang: string): unknown };

// Configure marked for safe, highlighted output
marked.setOptions({
  breaks: true,
  gfm: true,
});

/** HTML-escape a string using the DOM's built-in encoding. */
export function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

/** Render markdown to HTML string. */
export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

/** Set element innerHTML from markdown and apply syntax highlighting to code blocks. */
export function renderMarkdownInto(el: HTMLElement, text: string): void {
  el.innerHTML = renderMarkdown(text);
  if (typeof hljs !== 'undefined') {
    el.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block as HTMLElement);
    });
  }
}
