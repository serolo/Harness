// Minimal, SAFE markdown renderer for agent transcript text (plan Open Decision D3).
//
// Phase 2 deliberately avoids a markdown dependency (react-markdown/remark) to keep the
// sandboxed renderer's supply chain small. This renders a useful subset — paragraphs,
// fenced code blocks, inline code, bold, italic, links, and simple lists — by building
// REACT ELEMENTS (never `dangerouslySetInnerHTML`), so agent output can never inject
// HTML/script. Link hrefs are restricted to http/https/mailto (no `javascript:`).
//
// Fenced code renders in a styled <pre>; syntax highlighting via `shiki` (already a dep)
// is a deferred enhancement — SEAM: swap <CodeBlock> for an async shiki-highlighted
// variant when richer code display is wanted.

import React from 'react';

export interface MarkdownProps {
  text: string;
}

/** Render agent markdown text as safe React elements. */
export function Markdown({ text }: MarkdownProps): React.JSX.Element {
  return <>{renderBlocks(text)}</>;
}

/** Split into fenced-code vs prose blocks, preserving order. */
function renderBlocks(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Split on fenced code blocks: ```lang\n...\n```
  const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = fenceRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      out.push(...renderProse(text.slice(lastIndex, match.index), key));
      key += 1;
    }
    out.push(<CodeBlock key={`code-${key}`} code={match[2]} />);
    key += 1;
    lastIndex = fenceRe.lastIndex;
  }
  if (lastIndex < text.length) {
    out.push(...renderProse(text.slice(lastIndex), key));
  }
  return out;
}

/** A fenced code block (plain, monospace; shiki highlighting is a deferred seam). */
function CodeBlock({ code }: { code: string }): React.JSX.Element {
  return (
    <pre
      className="my-3 overflow-x-auto rounded-3 border border-border-1 bg-surface-well p-3 font-mono text-sm leading-6 text-fg-1"
      data-testid="code-block"
    >
      <code>{code.replace(/\n$/, '')}</code>
    </pre>
  );
}

/** Render a prose region: paragraphs + simple lists with inline formatting. */
function renderProse(prose: string, baseKey: number): React.ReactNode[] {
  const blocks = prose.split(/\n{2,}/);
  const out: React.ReactNode[] = [];
  blocks.forEach((block, i) => {
    const trimmed = block.trim();
    if (trimmed === '') return;
    const lines = trimmed.split('\n');
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const className =
        level === 1
          ? 'mb-3 mt-6 text-lg font-bold leading-tight text-fg-1'
          : level === 2
            ? 'mb-2 mt-5 text-md font-bold leading-tight text-fg-1'
            : 'mb-2 mt-4 text-base font-semibold leading-snug text-fg-1';
      out.push(
        <h2 key={`${baseKey}-h-${i}`} className={className}>
          {renderInline(heading[2])}
        </h2>,
      );
      return;
    }
    const isList = lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l));
    if (isList) {
      const ordered = /^\s*\d+\.\s+/.test(lines[0]);
      const items = lines.map((l, j) => (
        <li key={j}>{renderInline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>
      ));
      out.push(
        ordered ? (
          <ol
            key={`${baseKey}-ol-${i}`}
            className="my-3 list-decimal space-y-1.5 pl-5 text-base leading-6 text-fg-1"
          >
            {items}
          </ol>
        ) : (
          <ul
            key={`${baseKey}-ul-${i}`}
            className="my-3 list-disc space-y-1.5 pl-5 text-base leading-6 text-fg-1"
          >
            {items}
          </ul>
        ),
      );
    } else {
      out.push(
        <p
          key={`${baseKey}-p-${i}`}
          className="my-3 whitespace-pre-wrap text-base leading-6 text-fg-1"
        >
          {renderInline(trimmed)}
        </p>,
      );
    }
  });
  return out;
}

/**
 * Inline tokenizer for `code`, **bold**, *italic*, and [text](href). Emits React nodes;
 * text content is escaped by React, so no HTML injection is possible.
 */
function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Order matters: inline code first (its contents are literal), then link, bold, italic.
  const re = /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          className="rounded-2 border border-border-2 bg-bg-4 px-1.5 py-0.5 font-mono text-[0.88em] text-fg-1"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (linkMatch) {
        const href = safeHref(linkMatch[2]);
        nodes.push(
          href ? (
            <a
              key={key}
              href={href}
              className="text-link underline hover:text-link-hover"
              target="_blank"
              rel="noreferrer"
            >
              {linkMatch[1]}
            </a>
          ) : (
            linkMatch[1]
          ),
        );
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith('**')) {
      nodes.push(
        <strong key={key} className="font-semibold text-fg-1">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>,
      );
    }
    key += 1;
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

/** Allow only safe URL schemes; reject `javascript:`/`data:` etc. */
function safeHref(href: string): string | undefined {
  return /^(https?:|mailto:)/i.test(href) ? href : undefined;
}
