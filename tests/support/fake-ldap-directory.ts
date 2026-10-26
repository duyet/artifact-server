import {createServer as createTcpServer, type Server, type Socket} from "node:net";
import {createServer as createTlsServer} from "node:tls";

import {BerReader, BerWriter} from "ldapts";
import {z} from "zod";

/** One entry the fake directory binds and reads, keyed by its exact DN. */
export interface FakeLdapEntry {
  readonly attributes: Readonly<Record<string, readonly string[]>>;
  readonly password: string;
}

export interface FakeLdapDirectory {
  /** Every DN a client tried to bind as, in order, including failed binds. */
  readonly binds: readonly string[];
  readonly url: string;
  stop(): Promise<void>;
}

const operations = {
  bindRequest: 0x60,
  bindResponse: 0x61,
  searchDone: 0x65,
  searchEntry: 0x64,
  searchRequest: 0x63,
  unbindRequest: 0x42,
} as const;
const resultCodes = {
  authMethodNotSupported: 7,
  invalidCredentials: 49,
  noSuchObject: 32,
  success: 0,
} as const;

/**
 * A minimal in-process LDAP v3 server: simple bind, base-scope search, and
 * unbind. Like a permissive real directory, it accepts an empty-password bind
 * as an anonymous bind and lets that connection read entries.
 */
export async function startFakeLdapDirectory(options: {
  readonly entries: Readonly<Record<string, FakeLdapEntry>>;
  /** Accept connections and never answer, to exercise client timeouts. */
  readonly silent?: boolean;
  readonly tls?: {readonly certificate: string; readonly key: string};
}): Promise<FakeLdapDirectory> {
  const binds: string[] = [];
  const sockets = new Set<Socket>();
  const onConnection = (socket: Socket): void => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    if (options.silent === true) return;
    let pending = Buffer.alloc(0);
    let bound = false;
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (pending.length > 0 && pending[0] !== 0x30) {
          socket.destroy();
          return;
        }
        const frameLength = completeFrameLength(pending);
        if (frameLength === null) return;
        const frame = pending.subarray(0, frameLength);
        pending = pending.subarray(frameLength);
        const reader = new BerReader(frame);
        reader.readSequence();
        const messageId = reader.readInt() ?? 0;
        const operation = reader.peek();
        if (operation === operations.unbindRequest) {
          socket.end();
          return;
        }
        if (operation === operations.bindRequest) {
          reader.readSequence(operations.bindRequest);
          reader.readInt();
          const dn = reader.readString() ?? "";
          binds.push(dn);
          if (reader.peek() !== 0x80) {
            socket.write(result(messageId, operations.bindResponse, resultCodes.authMethodNotSupported));
            continue;
          }
          const password = reader.readString(0x80) ?? "";
          const entry = options.entries[dn];
          bound = password === "" || entry?.password === password;
          socket.write(result(
            messageId,
            operations.bindResponse,
            bound ? resultCodes.success : resultCodes.invalidCredentials,
          ));
          continue;
        }
        if (operation === operations.searchRequest) {
          reader.readSequence(operations.searchRequest);
          const base = reader.readString() ?? "";
          const entry = bound ? options.entries[base] : undefined;
          if (entry !== undefined) socket.write(searchEntry(messageId, base, entry));
          socket.write(result(
            messageId,
            operations.searchDone,
            entry === undefined ? resultCodes.noSuchObject : resultCodes.success,
          ));
        }
      }
    });
  };
  const server: Server = options.tls === undefined
    ? createTcpServer(onConnection)
    : createTlsServer({cert: options.tls.certificate, key: options.tls.key}, onConnection);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = z.object({port: z.number().int().positive()}).parse(server.address());
  return {
    binds,
    url: `${options.tls === undefined ? "ldap" : "ldaps"}://${options.tls === undefined ? "127.0.0.1" : "localhost"}:${address.port}`,
    stop: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

function completeFrameLength(buffer: Buffer): number | null {
  if (buffer.length < 2) return null;
  const reader = new BerReader(buffer);
  if (reader.readSequence(0x30) === null) return null;
  const total = reader.offset + reader.length;
  return buffer.length >= total ? total : null;
}

function result(messageId: number, operation: number, code: number): Buffer {
  const writer = new BerWriter();
  writer.startSequence();
  writer.writeInt(messageId);
  writer.startSequence(operation);
  writer.writeEnumeration(code);
  writer.writeString("");
  writer.writeString("");
  writer.endSequence();
  writer.endSequence();
  return writer.buffer;
}

function searchEntry(messageId: number, dn: string, entry: FakeLdapEntry): Buffer {
  const writer = new BerWriter();
  writer.startSequence();
  writer.writeInt(messageId);
  writer.startSequence(operations.searchEntry);
  writer.writeString(dn);
  writer.startSequence();
  for (const [name, values] of Object.entries(entry.attributes)) {
    writer.startSequence();
    writer.writeString(name);
    writer.startSequence(0x31);
    for (const value of values) writer.writeString(value);
    writer.endSequence();
    writer.endSequence();
  }
  writer.endSequence();
  writer.endSequence();
  writer.endSequence();
  return writer.buffer;
}
