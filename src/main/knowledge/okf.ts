export interface ParsedGatewayOkf {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) return value.slice(1, -1);
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((item) => String(parseScalar(item)));
  }
  return value;
}

/** Pure OKF parser: this module is safe in the Electron RUN_AS_NODE MCP entry. */
export function parseGatewayOkf(content: string): ParsedGatewayOkf {
  if (!content.startsWith('---\n')) throw new Error('missing frontmatter');
  const end = content.indexOf('\n---', 4);
  if (end < 0) throw new Error('missing frontmatter delimiter');
  const frontmatter: Record<string, unknown> = {};
  for (const line of content.slice(4, end).split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (match) frontmatter[match[1]] = parseScalar(match[2]);
  }
  return { frontmatter, body: content.slice(end + 4).replace(/^\r?\n/, '') };
}
