// The `x doctor` processes rows of the CLI catalog (`messages.ts` composes them): how many processes
// a production container of each role runs here, and the connections one container holds. Data only.

export const PROCESSES_MESSAGES = {
  'cli.doctor.processes':
    'processes per container, as a production container here would run them — {cores} core(s) seen, CPU budget {budget}:',
  'cli.doctor.processesUndeclared': 'undeclared — auto runs 1 process',
  'cli.doctor.processesRole':
    '  {role}: {count} process(es), bound by {binding} · pool {pool} + {listen} LISTEN = {connections} connection(s) per container',
  'cli.doctor.processesRefused': '  {role}: ULTIMATE_PROCESSES refused — {code}',
  'cli.doctor.processesConnections':
    '  one container of each role holds {total} connection(s); the server allows max_connections {max} — multiply by your replicas',
} as const;
