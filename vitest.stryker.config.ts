import viteConfig from './vite.config';

// Mutation runs only the tests that exercise the mutated modules (see stryker.config.json).
// Spread instead of mergeConfig: merging would concatenate the `include` arrays.
export default {
  ...viteConfig,
  test: {
    include: ['tests/io.test.ts', 'tests/auditC.test.ts', 'tests/adversarialProperties.test.ts'],
  },
};
