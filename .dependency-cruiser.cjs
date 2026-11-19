// Imports within one runtime are allowed. Runtime collaboration is via
// HTTP or documented protocols, not imports into another runtime's internals.
const runtimes = {web:'frontend/public',frontendGateway:'frontend/gateway',server:'server',connector:'connector',deploy:'deploy',storage:'storage'};
const npmTypes=['npm','npm-dev','npm-optional','npm-peer','npm-bundled','npm-no-pkg','npm-unknown'];

module.exports = {
  options: { doNotFollow: { path: "^node_modules/ws/" } },
  forbidden: [
    ...Object.entries(runtimes).map(([runtime, directory]) => ({
      name: `${runtime}-runtime-boundary`,
      severity: 'error',
      from: { path: `^${directory}/`, ...(runtime==='server'?{pathNot:'^server/im-attachments\\.mjs$'}:{}) },
      to: { dependencyTypes: ['local'], pathNot: `^${directory}/` },
    })),
    {
      name: 'server-attachments-boundary',
      severity: 'error',
      from: { path: '^server/im-attachments\\.mjs$' },
      to: { dependencyTypes: ['local'], pathNot: '^(?:server/|storage/index\\.mjs$)' },
    },
    {
      name: 'browser-no-node',
      severity: 'error',
      from: { path: '^frontend/public/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'no-runtime-packages',
      severity: 'error',
      from: { path: '^(frontend/public|frontend/gateway|server|connector|deploy|storage)/', pathNot: '^server/im-realtime\\.mjs$' },
      to: { dependencyTypes: npmTypes },
    },
    {
      name: 'im-realtime-npm-boundary',
      severity: 'error',
      from: { path: '^server/im-realtime\\.mjs$' },
      to: { dependencyTypes: npmTypes, pathNot: '^node_modules/ws/index\\.js$' },
    },
    { name: 'no-unresolved', severity: 'error', from: {}, to: { couldNotResolve: true } },
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
  ],
};
