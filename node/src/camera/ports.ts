import { randomInt } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer, isIP } from 'node:net';

import type { Socket } from 'node:dgram';

interface PickPortOptions {
  type: 'udp' | 'tcp';
  ip?: string;
  minPort?: number;
  maxPort?: number;
  reserveTimeout?: number;
}

// ports handed out but not yet bound by their owner, as "type:ip:port"
const reserved = new Set<string>();

let lastReservedPort: number | undefined;

function bindTcp(ip: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen({ host: ip, port, exclusive: true }, () => {
      server.close(() => resolve());
    });
  });
}

function bindUdp(ip: string, port: number, family: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(family === 4 ? 'udp4' : 'udp6');
    socket.unref();
    socket.on('error', reject);
    socket.bind({ address: ip, port, exclusive: true }, () => {
      socket.close(() => resolve());
    });
  });
}

export async function pickPort({ type, ip = '0.0.0.0', minPort = 10000, maxPort = 20000, reserveTimeout = 5 }: PickPortOptions): Promise<number> {
  const family = isIP(ip);

  if (type !== 'udp' && type !== 'tcp') {
    throw new TypeError('invalid type parameter');
  } else if (family !== 4 && family !== 6) {
    throw new TypeError('invalid ip parameter');
  } else if (typeof minPort !== 'number' || typeof maxPort !== 'number' || minPort > maxPort) {
    throw new TypeError('invalid minPort/maxPort parameter');
  } else if (typeof reserveTimeout !== 'number') {
    throw new TypeError('invalid reserveTimeout parameter');
  }

  if (lastReservedPort !== undefined && (lastReservedPort < minPort || lastReservedPort > maxPort)) {
    lastReservedPort = undefined;
  }

  // continue behind the last port handed out, so consecutive requests stay close
  let port = lastReservedPort ?? randomInt(minPort, maxPort + 1);
  let retries = maxPort - minPort + 1;

  while (--retries >= 0) {
    if (++port > maxPort) {
      port = minPort;
    }

    const hash = `${type}:${ip}:${port}`;
    if (reserved.has(hash)) {
      continue;
    }

    reserved.add(hash);

    try {
      await (type === 'tcp' ? bindTcp(ip, port) : bindUdp(ip, port, family));

      lastReservedPort = port;
      setTimeout(() => reserved.delete(hash), reserveTimeout * 1000).unref();

      return port;
    } catch (error) {
      reserved.delete(hash);

      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        throw error;
      }
    }
  }

  throw new Error('no available port in the given port range');
}

// Need to reserve ports in sequence because ffmpeg uses the next port up by default.  If it's taken, ffmpeg will error
export async function reservePorts({
  count = 1,
  type = 'udp',
  attemptNumber = 0,
}: {
  count?: number;
  type?: 'udp' | 'tcp';
  attemptNumber?: number;
} = {}): Promise<number[]> {
  if (attemptNumber > 100) {
    throw new Error('Failed to reserve ports after 100 tries');
  }

  const pickPortOptions = {
      type,
      reserveTimeout: 15, // 15 seconds is max setup time for HomeKit streams, so the port should be in use by then
    },
    port = await pickPort(pickPortOptions),
    ports = [port],
    tryAgain = () => {
      return reservePorts({
        count,
        type,
        attemptNumber: attemptNumber + 1,
      });
    };

  for (let i = 1; i < count; i++) {
    try {
      const targetConsecutivePort = port + i,
        openPort = await pickPort({
          ...pickPortOptions,
          minPort: targetConsecutivePort,
          maxPort: targetConsecutivePort,
        });

      ports.push(openPort);
    } catch {
      // can't reserve next port, bail and get another set
      return tryAgain();
    }
  }

  return ports;
}

export function bindToPort(socket: Socket, address = '127.0.0.1'): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    socket.on('error', reject);

    // 0 means select a random open port
    socket.bind(0, address, () => {
      const { port } = socket.address();
      resolve(port);
    });
  });
}
