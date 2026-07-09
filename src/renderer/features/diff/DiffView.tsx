// DiffView — the Monaco `DiffEditor` (@monaco-editor/react) for the selected file: old
// content on the left (original), new content on the right (modified), a side-by-side /
// unified toggle, and a large-file guard (skip auto-render over a line threshold with a
// "Show anyway" affordance — spec §9 / plan Task 10 gotcha).
//
// Gutter comments: a real Monaco gutter click is wired as a progressive enhancement
// (`onMount` registers a mousedown listener on the line-number gutter), but the
// PRIMARY, always-testable affordance is the small "+ Comment" popover in the toolbar
// below — it works identically under jsdom (where Monaco itself is mocked) and in the
// real app, and is what `DiffPanel.test.tsx` drives.

import { useMemo, useState } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import type { FileDiff } from '@shared/review';

export interface DiffViewProps {
  path: string | null;
  fileDiff: FileDiff | null;
  loading: boolean;
  onAddComment: (input: {
    lineStart: number;
    lineEnd: number;
    side: 'old' | 'new';
    body: string;
  }) => void;
}

/** Above this combined old+new line count, guard the auto-render (spec §9). */
const LARGE_FILE_LINE_THRESHOLD = 5000;

/** A pragmatic extension → Monaco language-id map; unknown extensions fall back to plaintext. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  rb: 'ruby',
  sh: 'shell',
  bash: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  toml: 'ini',
};

function languageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext';
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

export function DiffView({
  path,
  fileDiff,
  loading,
  onAddComment,
}: DiffViewProps): React.JSX.Element {
  const [sideBySide, setSideBySide] = useState(true);
  const [forceShow, setForceShow] = useState(false);
  const [commentOpen, setCommentOpen] = useState(false);
  const [lineDraft, setLineDraft] = useState('1');
  const [sideDraft, setSideDraft] = useState<'old' | 'new'>('new');
  const [bodyDraft, setBodyDraft] = useState('');

  const language = useMemo(
    () => (path ? languageFromPath(path) : 'plaintext'),
    [path],
  );
  const totalLines = fileDiff
    ? lineCount(fileDiff.oldContent) + lineCount(fileDiff.newContent)
    : 0;
  const isLarge = totalLines > LARGE_FILE_LINE_THRESHOLD;

  const handleMount: DiffOnMount = (diffEditor, monacoApi) => {
    // Progressive enhancement: clicking a line-number gutter opens the same popover,
    // pre-filled with that line + side. Guarded — some embed environments may not
    // expose the modified/original editors identically.
    const modified = diffEditor.getModifiedEditor?.();
    modified?.onMouseDown((e) => {
      const isGutter =
        e.target.type ===
          monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS ||
        e.target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
      if (isGutter && e.target.position) {
        setSideDraft('new');
        setLineDraft(String(e.target.position.lineNumber));
        setCommentOpen(true);
      }
    });
  };

  if (!path) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-slate-600"
        data-testid="diff-view-empty"
      >
        Select a file to view its diff.
      </div>
    );
  }

  if (loading || !fileDiff) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-slate-500"
        data-testid="diff-view-loading"
      >
        Loading diff…
      </div>
    );
  }

  function submitComment(): void {
    const line = Number.parseInt(lineDraft, 10);
    if (!Number.isFinite(line) || line < 1 || bodyDraft.trim() === '') return;
    onAddComment({
      lineStart: line,
      lineEnd: line,
      side: sideDraft,
      body: bodyDraft.trim(),
    });
    setBodyDraft('');
    setCommentOpen(false);
  }

  return (
    <div className="flex h-full flex-col" data-testid="diff-view">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-1.5">
        <span
          className="truncate font-mono text-xs text-slate-400"
          title={path}
        >
          {path}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800"
            data-testid="diff-view-toggle-layout"
            onClick={() => setSideBySide((v) => !v)}
          >
            {sideBySide ? 'Unified' : 'Side-by-side'}
          </button>
          <button
            type="button"
            className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800"
            data-testid="diff-view-add-comment"
            aria-expanded={commentOpen}
            onClick={() => setCommentOpen((v) => !v)}
          >
            + Comment
          </button>
        </div>
      </div>

      {commentOpen && (
        <div
          className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900/60 px-3 py-2"
          data-testid="comment-popover"
        >
          <label className="flex items-center gap-1 text-[11px] text-slate-500">
            Line
            <input
              type="number"
              min={1}
              className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-xs text-slate-200"
              value={lineDraft}
              data-testid="comment-line-input"
              onChange={(e) => setLineDraft(e.target.value)}
            />
          </label>
          <select
            className="rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-xs text-slate-200"
            value={sideDraft}
            data-testid="comment-side-select"
            onChange={(e) => setSideDraft(e.target.value as 'old' | 'new')}
          >
            <option value="new">New</option>
            <option value="old">Old</option>
          </select>
          <input
            type="text"
            placeholder="Comment…"
            className="min-w-[180px] flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600"
            value={bodyDraft}
            data-testid="comment-body-input"
            onChange={(e) => setBodyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitComment();
              }
            }}
          />
          <button
            type="button"
            className="rounded bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-500"
            data-testid="comment-submit"
            onClick={submitComment}
          >
            Add
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {isLarge && !forceShow ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-500"
            data-testid="diff-view-large-guard"
          >
            <p>
              This file has {totalLines.toLocaleString()} lines — rendering the
              full diff may be slow.
            </p>
            <button
              type="button"
              className="rounded border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800"
              data-testid="diff-view-show-anyway"
              onClick={() => setForceShow(true)}
            >
              Show anyway
            </button>
          </div>
        ) : (
          <DiffEditor
            original={fileDiff.oldContent}
            modified={fileDiff.newContent}
            language={language}
            theme="vs-dark"
            onMount={handleMount}
            options={{
              renderSideBySide: sideBySide,
              readOnly: true,
              minimap: { enabled: false },
            }}
          />
        )}
      </div>
    </div>
  );
}
