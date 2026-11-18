// Imports within one runtime are allowed. Runtime collaboration is via
// HTTP or documented protocols, not imports into another runtime's internals.
const runtimes = ['web', 'server', 'connector', 'deploy'];

module.exports = {
  forbidden: [
    ...runtimes.map(runtime => ({
      name: `${runtime}-runtime-boundary`,
      severity: 'error',
      from: { path: `^${runtime}/` },
      to: { dependencyTypes: ['local'], pathNot: `^${runtime}/` },
    })),
    {
      name: 'browser-no-node',
      severity: 'error',
      from: { path: '^web/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'no-runtime-packages',
      severity: 'error',
      from: { path: '^(web|server|connector|deploy)/' },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg', 'npm-unknown'],
      },
    },
    { name: 'no-unresolved', severity: 'error', from: {}, to: { couldNotResolve: true } },
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
  ],
};
