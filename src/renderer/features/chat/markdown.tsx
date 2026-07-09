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
      className="my-2 overflow-x-auto rounded-md bg-slate-950/70 p-3 text-xs text-slate-200 ring-1 ring-slate-800"
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
            className="my-1 list-decimal pl-5 text-sm"
          >
            {items}
          </ol>
        ) : (
          <ul
            key={`${baseKey}-ul-${i}`}
            className="my-1 list-disc pl-5 text-sm"
          >
            {items}
          </ul>
        ),
      );
    } else {
      out.push(
        <p
          key={`${baseKey}-p-${i}`}
          className="my-1 whitespace-pre-wrap text-sm"
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
          className="rounded bg-slate-800 px-1 py-0.5 text-[0.85em] text-amber-200"
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
              className="text-sky-400 underline"
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
        <strong key={key} className="font-semibold text-slate-100">
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
