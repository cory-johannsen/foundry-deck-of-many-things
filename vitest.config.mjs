import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    environment: 'node'
  },
  resolve: {
    alias: [
      {
        find: /^(\.\.\/)+foundry-pf2e-dungeon-crawl\/scripts\//,
        replacement: path.resolve(dirname, '../foundry-pf2e-dungeon-crawl/scripts/') + '/'
      }
    ]
  }
});
