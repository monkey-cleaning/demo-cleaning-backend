import { markdownToHtml } from './markdownToHtml.js';

export const DEFAULT_SECTION_HEADING = 'Introduction';

const H1_LINE = /^#\s+(?!#)\s*(.+)$/;
const SECTION_HEADING_LINE = /^(#{2,6})\s+(.+)$/;

/**
 * Elimina líneas H1 del markdown (el título vive en blog_posts.title).
 */
export function stripH1Lines(markdown) {
  return markdown
    .split('\n')
    .filter((line) => !H1_LINE.test(line.trim()))
    .join('\n')
    .trim();
}

/**
 * Divide markdown en bloques con heading obligatorio.
 * - H1 → ignorado (va en post.title)
 * - ## / ### / etc. → inicio de nueva sección
 * - Contenido previo al primer ## → sección "Introduction"
 */
export function parseMarkdownSections(markdown) {
  const stripped = stripH1Lines(markdown || '');

  if (!stripped) {
    return [{ heading: DEFAULT_SECTION_HEADING, bodyMarkdown: '' }];
  }

  const sections = [];
  let currentHeading = null;
  let currentLines = [];

  const flush = () => {
    const bodyMarkdown = currentLines.join('\n').trim();
    const heading = currentHeading || DEFAULT_SECTION_HEADING;

    if (bodyMarkdown || currentHeading) {
      sections.push({ heading, bodyMarkdown });
    }

    currentLines = [];
  };

  for (const line of stripped.split('\n')) {
    const trimmed = line.trim();
    const headingMatch = trimmed.match(SECTION_HEADING_LINE);

    if (headingMatch) {
      flush();
      currentHeading = headingMatch[2].trim();
      continue;
    }

    currentLines.push(line);
  }

  flush();

  if (sections.length === 0) {
    return [{ heading: DEFAULT_SECTION_HEADING, bodyMarkdown: stripped }];
  }

  return sections.map((section) => ({
    heading: section.heading || DEFAULT_SECTION_HEADING,
    bodyMarkdown: section.bodyMarkdown,
  }));
}

/**
 * Convierte markdown a filas listas para blog_sections.
 * Nunca devuelve heading null.
 */
export function markdownToSections(markdown) {
  const parsed = parseMarkdownSections(markdown);

  return parsed.map((section, idx) => ({
    section_order: idx + 1,
    heading: section.heading,
    body: null,
    body_html: markdownToHtml(section.bodyMarkdown),
    image_url: null,
    image_alt: null,
  }));
}
