import net from 'node:net';
import { networkInterfaces } from 'os';
import { networkInterfaces as ni } from 'systeminformation';

import type { NetworkInterfaceInfo } from 'os';
import type { Systeminformation } from 'systeminformation';

export type IPVersion = 'ipv4' | 'ipv6';

export interface UsableNetworkAddress {
  address: string;
  isPrivate: boolean;
}

function blockList(entries: [string, number, IPVersion?][]): net.BlockList {
  const list = new net.BlockList();

  for (const [ip, prefixLength, version = 'ipv4'] of entries) {
    list.addSubnet(ip, prefixLength, version);
  }

  return list;
}

const unusableRanges = blockList([
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['100.64.0.0', 10], // CG-NAT (also Tailscale's overlay range) — never routable from outside that overlay
  ['0.0.0.0', 8],
  ['240.0.0.0', 4],
  ['::1', 128, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
]);

const privateRanges = blockList([
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['fc00::', 7, 'ipv6'],
]);

export const isIPv4EmbeddedIPv6 = (ip: string): boolean => ip.includes(':') && ip.startsWith('::ffff:');

export const extractPureIPAddress = (address: string): string => (isIPv4EmbeddedIPv6(address) ? address.slice(7) : address);

export function buildHttpsUrl(address: string, port: number): string {
  const clean = extractPureIPAddress(address);
  const hostPart = clean.includes(':') ? `[${clean}]` : clean;
  return `https://${hostPart}:${port}`;
}

function ipVersionOf(ip: string): IPVersion | undefined {
  if (!ip) {
    return undefined;
  }

  const family = net.isIP(extractPureIPAddress(ip));
  if (family === 4) {
    return 'ipv4';
  }

  return family === 6 ? 'ipv6' : undefined;
}

export const isValidNetworkAddress = (ip: string): boolean => {
  const version = ipVersionOf(ip);
  return version ? !unusableRanges.check(extractPureIPAddress(ip), version) : false;
};

export const isInternalNetworkAddress = (ip: string): boolean => {
  const version = ipVersionOf(ip);
  return version ? privateRanges.check(extractPureIPAddress(ip), version) : false;
};

export function isLoopbackAddress(ip: string): boolean {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('::ffff:127.')) return true;
  return false;
}

export function isLoopbackHost(host: string): boolean {
  if (!host) return false;
  let hostname = host;
  if (hostname.startsWith('[')) {
    const close = hostname.indexOf(']');
    if (close === -1) return false;
    hostname = hostname.slice(1, close);
  } else {
    const colon = hostname.lastIndexOf(':');
    if (colon !== -1 && !hostname.includes('::')) hostname = hostname.slice(0, colon);
  }
  if (hostname === 'localhost') return true;
  return isLoopbackAddress(hostname);
}

export function isLanClientAddress(remoteIp: string | undefined, localIp: string | undefined): boolean {
  if (!remoteIp || !localIp) return false;
  if (isLoopbackAddress(localIp)) return false;

  const remote = extractPureIPAddress(remoteIp);
  const local = extractPureIPAddress(localIp);

  if (net.isIPv4(remote)) {
    if (remote === '127.0.0.1') return true;
    if (remote.startsWith('10.') || remote.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(remote)) return true;
    return false;
  }

  if (net.isIPv6(remote)) {
    const r = remote.toLowerCase();
    if (r === '::1') return true;
    if (r.startsWith('fc') || r.startsWith('fd')) return true;
    if (r.startsWith('fe80:')) return true;

    if (net.isIPv6(local)) {
      try {
        const block = new net.BlockList();
        block.addSubnet(local, 64, 'ipv6');
        return block.check(remote, 'ipv6');
      } catch {
        return false;
      }
    }
  }

  return false;
}

const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|cni|lxc|lxd)/;

export const fetchViableNetworkAddresses = (): UsableNetworkAddress[] => {
  const interfaces = Object.entries(networkInterfaces())
    .filter(([name]) => !VIRTUAL_INTERFACE.test(name))
    .flatMap(([, infos]) => infos ?? [])
    .filter((ni): ni is NetworkInterfaceInfo => ni !== undefined);

  const isValidInterface = (ni: NetworkInterfaceInfo) => isValidNetworkAddress(ni.address) && !ni.internal;

  return interfaces.filter(isValidInterface).map((ni) => ({
    address: ni.address,
    isPrivate: isInternalNetworkAddress(ni.address),
  }));
};

export const getSystemNetworkInterfaces = async (): Promise<Systeminformation.NetworkInterfacesData[]> => {
  let allInterfaces = await ni();

  if (!Array.isArray(allInterfaces)) {
    allInterfaces = [allInterfaces];
  }

  const interfaces = allInterfaces.filter((adapter) => {
    return !adapter.internal && (adapter.ip4 || adapter.ip6);
  });

  return interfaces;
};
