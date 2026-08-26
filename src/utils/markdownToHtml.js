import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: true,
});

/**
 * Convierte Markdown a HTML para blog_sections.body_html.
 */
export function markdownToHtml(markdown) {
  if (!markdown || typeof markdown !== 'string') return '';
  return marked.parse(markdown.trim());
}
