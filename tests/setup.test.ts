import { expect, it } from 'vitest';

it('loads the TypeScript entry point', async () => {
  await expect(import('../src/index.js')).resolves.toBeDefined();
});
