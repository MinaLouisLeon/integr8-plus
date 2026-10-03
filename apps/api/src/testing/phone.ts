import { createClient } from '@integr8/api-client';
import {
  type ChangeContext,
  type DeviceClock,
  LocalDatabase,
  migrate,
  SyncEngine,
  type SyncRunSummary,
  type SyncTrigger,
  syncApiFor,
} from '@integr8/offline';
import { NodeSqlDriver } from '@integr8/offline/testing';
import { webcrypto } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ApiHarness, Member } from './api-harness.js';

/**
 * A phone, for sync's integration suites (P12).
 *
 * The real sync engine and local database — the same code the mobile app runs —
 * on Node's SQLite, talking to the real API and database in this process. Every
 * request, to the API and to storage, goes through a {@link FlakyNetwork} that a
 * test can switch off, slow, or break at exactly the request it wants: before
 * the server sees it (the request is lost) or after (the answer is lost).
 *
 * "Killing the app" is {@link Phone.kill}: the engine is dropped mid-flight and a
 * new one opened on the same database file, as an app relaunched after being
 * swiped away would be.
 */

export type Stage = 'before' | 'after';

interface Rule {
  matches: (method: string, path: string) => boolean;
  stage: Stage;
  remaining: number;
  /** A status to answer with instead of failing the connection. */
  status?: number;
  onMatch?: () => void;
}

export class FlakyNetwork {
  online = true;
  readonly log: { method: string; path: string; status: number | 'lost' }[] = [];
  readonly #rules: Rule[] = [];

  /** Loses the next `times` matching requests at `stage`. */
  lose(
    matches: (method: string, path: string) => boolean,
    options: { stage: Stage; times?: number; onMatch?: () => void },
  ): void {
    this.#rules.push({
      matches,
      stage: options.stage,
      remaining: options.times ?? 1,
      ...(options.onMatch === undefined ? {} : { onMatch: options.onMatch }),
    });
  }

  /** Answers the next `times` matching requests with `status`, without the server seeing them. */
  fail(matches: (method: string, path: string) => boolean, status: number, times = 1): void {
    this.#rules.push({ matches, stage: 'before', remaining: times, status });
  }

  /** @internal */
  async send(
    method: string,
    path: string,
    deliver: () => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>,
  ) {
    if (!this.online) {
      this.log.push({ method, path, status: 'lost' });
      throw new TypeError('fetch failed: the network is off');
    }
    const rule = this.#rules.find(
      (candidate) => candidate.remaining > 0 && candidate.matches(method, path),
    );
    if (rule !== undefined) {
      rule.remaining -= 1;
      rule.onMatch?.();
    }
    if (rule?.stage === 'before') {
      if (rule.status !== undefined) {
        this.log.push({ method, path, status: rule.status });
        return {
          status: rule.status,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(
            JSON.stringify({
              error: { code: 'unavailable', message: 'Unavailable', requestId: 'net' },
            }),
          ),
        };
      }
      this.log.push({ method, path, status: 'lost' });
      throw new TypeError('fetch failed: the request was lost');
    }
    const answer = await deliver();
    if (rule?.stage === 'after') {
      this.log.push({ method, path, status: 'lost' });
      throw new TypeError('fetch failed: the answer was lost');
    }
    this.log.push({ method, path, status: answer.status });
    return answer;
  }

  count(method: string, pathPattern: RegExp): number {
    return this.log.filter((entry) => entry.method === method && pathPattern.test(entry.path))
      .length;
  }
}

export class SkewedClock implements DeviceClock {
  constructor(public offsetMs = 0) {}
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
}

export interface Phone {
  db: LocalDatabase;
  engine: SyncEngine;
  context: ChangeContext;
  network: FlakyNetwork;
  clock: SkewedClock;
  battery: { level: number | null; charging: boolean };
  path: string;
  sync(trigger?: SyncTrigger, force?: boolean): Promise<SyncRunSummary>;
  /** Drops this engine and database connection mid-flight, and opens the phone again. */
  kill(): Promise<Phone>;
}

const random = (length: number) => webcrypto.getRandomValues(new Uint8Array(length));

export async function openPhone(
  api: ApiHarness,
  member: Member,
  options: { network?: FlakyNetwork; clock?: SkewedClock; path?: string; token?: string } = {},
): Promise<Phone> {
  const network = options.network ?? new FlakyNetwork();
  const clock = options.clock ?? new SkewedClock();
  const token = options.token ?? (await api.signIn(member));
  const path = options.path ?? join(mkdtempSync(join(tmpdir(), 'integr8-phone-')), 'local.db');
  const battery = { level: null as number | null, charging: false };

  const inject = async (
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: Buffer | undefined,
  ) => {
    const response = await api.app.inject({
      method: method as 'GET',
      url: `${url.pathname}${url.search}`,
      remoteAddress: api.remoteAddress,
      headers,
      ...(body === undefined || body.length === 0 ? {} : { payload: body }),
    });
    return {
      status: response.statusCode,
      headers: Object.fromEntries(
        Object.entries(response.headers).map(([name, value]) => [name, String(value)]),
      ),
      body: response.rawPayload,
    };
  };

  const client = createClient({
    baseUrl: 'http://api.test',
    clientApp: 'mobile',
    clientVersion: '1.0.0',
    getAccessToken: () => token,
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
      const answer = await network.send(request.method, url.pathname, () =>
        inject(request.method, url, Object.fromEntries(request.headers.entries()), body),
      );
      return new Response(answer.status === 204 ? null : new Uint8Array(answer.body), {
        status: answer.status,
        headers: answer.headers,
      });
    },
  });

  const driver = new NodeSqlDriver(path);
  await migrate(driver);
  const db = new LocalDatabase(driver);

  const engine = new SyncEngine({
    db,
    api: syncApiFor(client),
    clock,
    random,
    appVersion: '1.0.0',
    files: {
      exists: async (file) => (await stat(file).catch(() => undefined)) !== undefined,
      read: async (file, offset, length) => {
        const handle = await open(file, 'r');
        try {
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          return new Uint8Array(buffer.subarray(0, bytesRead));
        } finally {
          await handle.close();
        }
      },
    },
    transport: {
      put: async (link, headers, body) => {
        const url = new URL(link);
        const answer = await network.send('PUT', url.pathname, () =>
          inject(
            'PUT',
            url,
            { ...headers, 'content-length': String(body.byteLength) },
            Buffer.from(body),
          ),
        );
        return { status: answer.status };
      },
      download: async (link, relative) => {
        const url = new URL(link);
        const answer = await network.send('GET', url.pathname, () =>
          inject('GET', url, {}, undefined),
        );
        if (answer.status === 200) {
          const target = join(dirname(path), 'files', relative);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, answer.body);
        }
        return { status: answer.status };
      },
    },
    conditions: () =>
      Promise.resolve({
        online: network.online,
        networkType: 'wifi',
        batteryLevel: battery.level,
        charging: battery.charging,
      }),
  });

  const phone: Phone = {
    db,
    engine,
    context: { db, clock, random },
    network,
    clock,
    battery,
    path,
    sync: (trigger = 'manual', force = false) => engine.run({ trigger, force }),
    kill: () => openPhone(api, member, { network, clock, path, token }),
  };
  return phone;
}
