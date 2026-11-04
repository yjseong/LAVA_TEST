// BeautifulSoup-compatible text helpers on top of cheerio.
//
// The Python parsers rely on bs4's exact get_text() semantics (strings joined with a separator, optionally
// stripped one by one; <script>/<style>/comments ignored). cheerio's .text() joins WITHOUT stripping, so
// "a <b>b</b>" differs ("a b" vs bs4's "ab" with strip=True). Parsers port 1:1 only if these match.
import type { AnyNode } from "domhandler";

function collect(node: AnyNode, out: string[]): void {
  switch (node.type) {
    case "text":
      out.push(node.data);
      break;
    case "cdata":
    case "tag":
    case "root":
      for (const child of node.children) collect(child, out);
      break;
    default:
      // script / style / comment / directive: bs4's get_text() skips them as well
      break;
  }
}

/** bs4 `el.get_text(sep, strip=...)` */
export function getText(node: AnyNode | null | undefined, sep = "", strip = false): string {
  if (!node) return "";
  const parts: string[] = [];
  collect(node, parts);
  const pieces = strip ? parts.map((s) => s.trim()).filter((s) => s !== "") : parts;
  return pieces.join(sep);
}
