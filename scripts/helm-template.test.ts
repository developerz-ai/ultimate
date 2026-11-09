// docker/helm's NetworkPolicy filters egress by default: a pod reaches DNS, every cluster pod and
// every routable address — private ranges included, where a managed database lives (RDS on 10.x) —
// and never the cloud metadata endpoint (169.254.169.254 hands out the node's credentials) or
// link-local, over IPv4, IPv6 or NAT64.
//
// The values assertions always run; the render ones when a helm binary is on PATH (CI ships one).

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const CHART = join(repoRoot(), 'docker', 'helm');
const HELM = Bun.which('helm');

/** What no default egress rule may reach: metadata and link-local, by every address family. */
const CLOSED_V4 = ['169.254.0.0/16'];
const CLOSED_V6 = ['fe80::/10', 'fd00:ec2::254/128', '64:ff9b::a9fe:a9fe/128'];
/** What the default must NOT close: a private backend the chart cannot know the address of. */
const PRIVATE = ['10.0.0.0/8', '100.64.0.0/10', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'];

/** NodeLocal DNSCache's well-known address: the one fixed block a default may name, on 53 only. */
const NODE_LOCAL_DNS = '169.254.20.10/32';

interface Peer {
  readonly ipBlock?: { readonly cidr: string; readonly except?: readonly string[] };
  readonly podSelector?: unknown;
  readonly namespaceSelector?: unknown;
}
interface EgressRule {
  readonly to?: readonly Peer[];
  readonly ports?: readonly { readonly port: number | string; readonly protocol?: string }[];
}
interface Policy {
  readonly kind: string;
  readonly metadata: { readonly name: string };
  readonly spec: {
    readonly policyTypes: readonly string[];
    readonly egress?: readonly EgressRule[];
  };
}

const defaultEgress = async (): Promise<readonly EgressRule[]> => {
  const values = Bun.YAML.parse(await Bun.file(join(CHART, 'values.yaml')).text()) as {
    networkPolicy?: { egress?: readonly EgressRule[] };
  };
  return values.networkPolicy?.egress ?? [];
};

/** Every refusal the rules imply, as one list a failure prints whole. */
function openings(rules: readonly EgressRule[]): readonly string[] {
  const found: string[] = [];
  for (const [index, rule] of rules.entries()) {
    // No `to` is "any destination" on the listed ports — DNS included: an open 53 reaches every
    // private host's resolver, and a tunnel over it.
    if (rule.to === undefined || rule.to.length === 0) {
      found.push(`rule ${index}: any destination on ${JSON.stringify(rule.ports)}`);
      continue;
    }
    const dnsOnly =
      (rule.ports?.length ?? 0) > 0 && (rule.ports ?? []).every((port) => port.port === 53);
    for (const peer of rule.to) {
      const block = peer.ipBlock;
      if (block === undefined) continue;
      const closed = block.cidr.includes(':') ? CLOSED_V6 : CLOSED_V4;
      const wide = block.cidr === '0.0.0.0/0' || block.cidr === '::/0';
      if (!wide && !(dnsOnly && block.cidr === NODE_LOCAL_DNS)) {
        found.push(`rule ${index}: a fixed block ${block.cidr} in the chart's default`);
        continue;
      }
      if (!wide) continue;
      for (const cidr of closed) {
        if (!(block.except ?? []).includes(cidr)) {
          found.push(`rule ${index}: ${block.cidr} without excepting ${cidr}`);
        }
      }
    }
  }
  return found;
}

describe('unit · docker/helm egress, closed by default', () => {
  test('the default values filter egress', async () => {
    expect((await defaultEgress()).length).toBeGreaterThan(0);
  });

  test('no default rule reaches metadata or link-local', async () => {
    expect(openings(await defaultEgress())).toEqual([]);
  });

  test('private ranges stay reachable — a managed database on a VPC address survives the upgrade', async () => {
    const excepted = (await defaultEgress()).flatMap((rule) =>
      (rule.to ?? []).flatMap((peer) => peer.ipBlock?.except ?? []),
    );
    expect(PRIVATE.filter((cidr) => excepted.includes(cidr))).toEqual([]);
  });

  test('DNS goes to cluster pods and NodeLocal DNSCache only, never any host', async () => {
    const dns = (await defaultEgress()).filter((rule) =>
      (rule.ports ?? []).some((port) => port.port === 53),
    );
    expect(dns.map((rule) => rule.to)).toEqual([
      [{ namespaceSelector: {} }, { ipBlock: { cidr: NODE_LOCAL_DNS } }],
    ]);
  });

  test('DNS resolves, over UDP and TCP', async () => {
    const dns = (await defaultEgress()).flatMap((rule) =>
      (rule.ports ?? []).filter((port) => port.port === 53).map((port) => port.protocol),
    );
    expect([...new Set(dns)].sort()).toEqual(['TCP', 'UDP']);
  });

  test('every cluster pod stays reachable on every port — a CNI whose ipBlock skips pods included', async () => {
    const pods = (await defaultEgress()).some(
      (rule) =>
        rule.ports === undefined &&
        (rule.to ?? []).some(
          (peer) =>
            JSON.stringify(peer.namespaceSelector) === '{}' && peer.podSelector === undefined,
        ),
    );
    expect(pods).toBe(true);
  });

  test('the check itself notices an open rule', () => {
    expect(openings([{ to: [{ ipBlock: { cidr: '0.0.0.0/0' } }] }])).toContain(
      'rule 0: 0.0.0.0/0 without excepting 169.254.0.0/16',
    );
    expect(openings([{ ports: [{ port: 443, protocol: 'TCP' }] }])).toHaveLength(1);
    expect(openings([{ ports: [{ port: 53, protocol: 'UDP' }] }])).toHaveLength(1);
    expect(openings([{ to: [{ ipBlock: { cidr: NODE_LOCAL_DNS } }] }])).toHaveLength(1);
  });
});

const RENDER_DEADLINE_MS = 30_000;

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

/** One awaited, deadlined render of the NetworkPolicies — see helm-drain.test.ts for why awaited. */
async function policies(extra: readonly string[] = []): Promise<readonly Policy[]> {
  const child = Bun.spawn(
    [HELM ?? 'helm', 'template', 'app', CHART, '--set', 'roles.sync.enabled=true', ...extra],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    // real-clock: a deadline on the helm child process, which runs on its own time.
    timer = setTimeout(() => resolve('late'), RENDER_DEADLINE_MS);
  });
  const outReader = child.stdout.getReader();
  const errReader = child.stderr.getReader();
  const settled = await Promise.race([
    Promise.all([readAll(outReader), readAll(errReader), child.exited]),
    late,
  ]);
  clearTimeout(timer);
  if (settled === 'late') {
    child.kill('SIGKILL');
    await Promise.allSettled([outReader.cancel(), errReader.cancel()]);
    return expect.unreachable(`helm template did not finish within ${RENDER_DEADLINE_MS} ms`);
  }
  const [stdout, stderr, exitCode] = settled;
  if (exitCode !== 0) return expect.unreachable(`helm template: ${stderr}`);
  const parsed: unknown = Bun.YAML.parse(stdout);
  const docs = (Array.isArray(parsed) ? parsed : [parsed]) as (Policy | null)[];
  return docs.filter((doc): doc is Policy => doc?.kind === 'NetworkPolicy');
}

describe.skipIf(HELM === null)('unit · docker/helm NetworkPolicy rendered', () => {
  test('a default render filters egress on every role, and excepts the metadata range', async () => {
    const rendered = await policies();
    expect(rendered.map((doc) => doc.metadata.name).sort()).toEqual([
      'app-ultimate-scheduler',
      'app-ultimate-sync',
      'app-ultimate-web',
      'app-ultimate-worker',
    ]);
    for (const doc of rendered) {
      expect({ name: doc.metadata.name, types: doc.spec.policyTypes }).toEqual({
        name: doc.metadata.name,
        types: ['Ingress', 'Egress'],
      });
      expect(openings(doc.spec.egress ?? [])).toEqual([]);
      const excepted = (doc.spec.egress ?? []).flatMap((rule) =>
        (rule.to ?? []).flatMap((peer) => peer.ipBlock?.except ?? []),
      );
      expect(excepted).toContain('169.254.0.0/16');
    }
  });

  test('an operator’s own list replaces the default, and an empty one turns filtering off', async () => {
    const own = await policies([
      '--set-json',
      'networkPolicy.egress=[{"to":[{"ipBlock":{"cidr":"10.1.0.0/16"}}]}]',
    ]);
    expect(own[0]?.spec.egress).toEqual([{ to: [{ ipBlock: { cidr: '10.1.0.0/16' } }] }]);
    const off = await policies(['--set-json', 'networkPolicy.egress=[]']);
    expect(off[0]?.spec.policyTypes).toEqual(['Ingress']);
    expect(off[0]?.spec.egress).toBeUndefined();
  });
});
