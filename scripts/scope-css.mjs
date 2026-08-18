import { readFile, readdir, writeFile } from 'node:fs/promises';
import postcss from 'postcss';
import prefixSelector from 'postcss-prefix-selector';

const prefix = '.marketmap-app';
const marker = '/* scoped: marketmap-app */';
const nonRuleFiles = new Set(['embed.css', 'fonts.css', 'marketmap.css']);
const files = (await readdir('css'))
  .filter((file) => file.endsWith('.css') && !nonRuleFiles.has(file))
  .sort()
  .map((file) => `css/${file}`);

const transform = (prefixValue, selector) => {
  if (selector.startsWith(prefixValue)) return selector;
  if (selector.startsWith(':root')) return selector.replace(/^:root/, prefixValue);
  if (selector.startsWith('html')) return selector.replace(/^html/, prefixValue);
  if (selector.startsWith('body')) return selector.replace(/^body/, prefixValue);
  return `${prefixValue} ${selector}`;
};

for (const file of files) {
  const source = await readFile(file, 'utf8');
  if (source.startsWith(marker)) continue;

  const result = await postcss([
    prefixSelector({
      prefix,
      transform,
      exclude: [/^\.marketmap-app(?:\b|[.:[#])/],
    }),
  ]).process(source, { from: file, to: file, map: false });

  await writeFile(file, `${marker}\n${result.css}`);
}
