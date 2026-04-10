/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'node16',
          moduleResolution: 'node16',
          target: 'es2022',
          isolatedModules: true,
          types: ['node', 'jest'],
        },
      },
    ],
  },
};
