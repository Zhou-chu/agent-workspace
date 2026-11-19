// Imports within one runtime are allowed. Runtime collaboration is via
// HTTP or documented protocols, not imports into another runtime's internals.
const runtimes = {web:'frontend/public',server:'server',connector:'connector',deploy:'deploy'};

module.exports = {
  forbidden: [
    ...Object.entries(runtimes).map(([runtime, directory]) => ({
      name: `${runtime}-runtime-boundary`,
      severity: 'error',
      from: { path: `^${directory}/` },
      to: { dependencyTypes: ['local'], pathNot: `^${directory}/` },
    })),
    {
      name: 'browser-no-node',
      severity: 'error',
      from: { path: '^frontend/public/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'no-runtime-packages',
      severity: 'error',
      from: { path: '^(frontend/public|server|connector|deploy)/' },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg', 'npm-unknown'],
      },
    },
    { name: 'no-unresolved', severity: 'error', from: {}, to: { couldNotResolve: true } },
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
  ],
};
