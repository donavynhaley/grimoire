import type { Image, PhrasingContent, Root, Text } from "mdast";
import { visit } from "unist-util-visit";

const EMBED_PATTERN = /!\[\[([^\][\n|]+?)(?:\|([^\][\n]+?))?\]\]/g;

/**
 * Renders Obsidian-style image embeds the way Obsidian does.
 *
 * `![[name.png]]` becomes an image resolved by file name, `![[name.png|300]]`
 * and `![[name.png|300x200]]` carry Obsidian's display sizes, and any other
 * modifier is treated as the alt text. Working on the parsed tree means embeds
 * inside code blocks and inline code stay literal text, exactly as in Obsidian.
 */
export function remarkObsidianEmbeds() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;
      const value = node.value;
      const matches = [...value.matchAll(EMBED_PATTERN)];
      if (matches.length === 0) return;

      const replacements: PhrasingContent[] = [];
      let consumed = 0;
      for (const match of matches) {
        if (match.index > consumed) replacements.push({ type: "text", value: value.slice(consumed, match.index) });
        replacements.push(embedImage(match[1].trim(), match[2]?.trim()));
        consumed = match.index + match[0].length;
      }
      if (consumed < value.length) replacements.push({ type: "text", value: value.slice(consumed) });

      parent.children.splice(index, 1, ...replacements);
      return index + replacements.length;
    });
  };
}

function embedImage(name: string, modifier: string | undefined): Image {
  const dimensions = modifier?.match(/^(\d+)(?:x(\d+))?$/);
  const image: Image = { type: "image", url: name, alt: dimensions ? "" : (modifier ?? "") };
  if (dimensions) {
    const properties: Record<string, number> = { width: Number(dimensions[1]) };
    if (dimensions[2]) properties.height = Number(dimensions[2]);
    image.data = { hProperties: properties };
  }
  return image;
}
