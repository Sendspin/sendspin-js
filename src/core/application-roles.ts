import type { ApplicationRole, ApplicationRoleSession } from "../types";

const ROLE_ID = /^_[^@]+@[^@]+$/;
const MIN_BINARY_ID = 192;
const MAX_BINARY_ID = 255;

interface ApplicationRoleDeps {
  sendControl(msg: object, role: string): void;
  sendBinary(type: number, data: Uint8Array, role: string): void;
  sendState(): void;
  computeClientTime(serverTimeUs: number): number;
  computeServerTime(clientTimeUs: number): number;
}

interface Activation {
  streamActive: boolean;
  clientStreamOpen: boolean;
}

const familyOf = (id: string): string => id.split("@")[0];

function validate(roles: ApplicationRole[]): void {
  const ids = new Set<string>();
  const binaryOwners = new Map<number, string>();
  for (const role of roles) {
    if (!ROLE_ID.test(role.id)) {
      throw new Error(
        `Application role id ${JSON.stringify(role.id)} must start with "_" and end in "@<version>"`,
      );
    }
    if (ids.has(role.id)) {
      throw new Error(`Application role ${role.id} is listed twice`);
    }
    ids.add(role.id);
    const family = familyOf(role.id);
    for (const id of role.binaryMessageIds ?? []) {
      if (!Number.isInteger(id) || id < MIN_BINARY_ID || id > MAX_BINARY_ID) {
        throw new RangeError(
          `Application role ${role.id} binary message ID ${id} is outside ${MIN_BINARY_ID}-${MAX_BINARY_ID}`,
        );
      }
      const owner = binaryOwners.get(id);
      if (owner !== undefined && owner !== family) {
        throw new Error(
          `Binary message ID ${id} is claimed by both ${owner} and ${family}`,
        );
      }
      binaryOwners.set(id, family);
    }
  }
}

export class ApplicationRoles {
  private active = new Map<ApplicationRole, Activation>();
  private serverHello: Record<string, unknown> = {};

  constructor(
    private roles: ApplicationRole[],
    private deps: ApplicationRoleDeps,
  ) {
    validate(roles);
  }

  get supportedRoles(): string[] {
    return this.roles.map((role) => role.id);
  }

  get helloSupport(): Record<string, unknown> {
    return Object.fromEntries(
      this.roles
        .filter((role) => role.support !== undefined)
        .map((role) => [`${role.id}_support`, role.support]),
    );
  }

  /** Returns whether a role was added. */
  applyActivation(activeRoles: ReadonlySet<string>): boolean {
    for (const [role, activation] of this.active) {
      if (activeRoles.has(role.id)) continue;
      this.active.delete(role);
      if (activation.clientStreamOpen) {
        this.deps.sendControl(clientStreamEnd(role), role.id);
      }
      call(role, "onDeactivate", () => role.onDeactivate?.());
    }
    let added = false;
    for (const role of this.roles) {
      if (!activeRoles.has(role.id) || this.active.has(role)) continue;
      const activation = { streamActive: false, clientStreamOpen: false };
      this.active.set(role, activation);
      added = true;
      const session = this.createSession(role, activation);
      call(role, "onActivate", () => role.onActivate?.(session));
    }
    return added;
  }

  /** Deactivate every role without messaging the server, which is gone. */
  deactivateAll(): void {
    const roles = [...this.active.keys()];
    this.active.clear();
    for (const role of roles) {
      call(role, "onDeactivate", () => role.onDeactivate?.());
    }
  }

  clientStateObjects(): Record<string, unknown> {
    const objects: Record<string, unknown> = {};
    for (const role of this.active.keys()) {
      if (!role.getState) continue;
      const state = call(role, "getState", () => role.getState?.());
      if (state !== undefined) objects[familyOf(role.id)] = state;
    }
    return objects;
  }

  handleMessage(msg: { type: string; payload?: unknown }): void {
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    if (msg.type === "server/hello") {
      this.serverHello = payload;
      return;
    }
    const serverTransmittedUs = payload.server_transmitted as number;
    const roles = Array.isArray(payload.roles)
      ? (payload.roles as unknown[])
      : undefined;
    for (const [role, activation] of this.active) {
      const family = familyOf(role.id);
      switch (msg.type) {
        case "server/state":
          if (family in payload) {
            call(role, "onServerState", () =>
              role.onServerState?.(payload[family]),
            );
          }
          break;
        case "server/command":
          if (family in payload) {
            call(role, "onServerCommand", () =>
              role.onServerCommand?.(payload[family]),
            );
          }
          break;
        case "stream/start":
          if (family in payload) {
            const isUpdate = activation.streamActive;
            activation.streamActive = true;
            call(role, "onStreamStart", () =>
              role.onStreamStart?.(
                payload[family],
                isUpdate,
                serverTransmittedUs,
              ),
            );
          }
          break;
        case "stream/clear":
          // Without a role list, stream/clear targets only player and visualizer.
          if (roles?.includes(family)) {
            call(role, "onStreamClear", () =>
              role.onStreamClear?.(serverTransmittedUs),
            );
          }
          break;
        case "stream/end":
          if (roles ? roles.includes(family) : activation.streamActive) {
            activation.streamActive = false;
            call(role, "onStreamEnd", () => role.onStreamEnd?.());
          }
          break;
      }
    }
  }

  /** Returns false for IDs below the application range, which the caller handles. */
  handleBinary(bytes: Uint8Array, receivedAtUs: number): boolean {
    const id = bytes[0];
    if (id < MIN_BINARY_ID) return false;
    for (const role of this.active.keys()) {
      if (!role.binaryMessageIds?.includes(id)) continue;
      call(role, "onBinaryMessage", () =>
        role.onBinaryMessage?.(id, bytes.subarray(1), receivedAtUs),
      );
      break;
    }
    return true;
  }

  private createSession(
    role: ApplicationRole,
    activation: Activation,
  ): ApplicationRoleSession {
    const family = familyOf(role.id);
    const deps = this.deps;
    const isActive = () => this.active.get(role) === activation;
    return {
      serverSupport: this.serverHello[`${role.id}_support`],
      sendCommand(command) {
        if (!isActive()) return;
        deps.sendControl(
          { type: "client/command", payload: { [family]: command } },
          role.id,
        );
      },
      sendState() {
        if (isActive()) deps.sendState();
      },
      sendBinaryMessage(id, data) {
        if (!role.binaryMessageIds?.includes(id)) {
          throw new RangeError(
            `Binary message ID ${id} is not assigned to ${role.id}`,
          );
        }
        if (isActive()) deps.sendBinary(id, data, role.id);
      },
      startClientStream(config) {
        if (!isActive()) return;
        activation.clientStreamOpen = true;
        deps.sendControl(
          { type: "client-stream/start", payload: { [family]: config } },
          role.id,
        );
      },
      endClientStream() {
        if (!isActive()) return;
        activation.clientStreamOpen = false;
        deps.sendControl(clientStreamEnd(role), role.id);
      },
      computeClientTime: (serverTimeUs) => deps.computeClientTime(serverTimeUs),
      computeServerTime: (clientTimeUs) => deps.computeServerTime(clientTimeUs),
    };
  }
}

function call<T>(
  role: ApplicationRole,
  hook: string,
  fn: () => T,
): T | undefined {
  try {
    return fn();
  } catch (e) {
    console.error(`Sendspin: application role ${role.id} ${hook} threw`, e);
    return undefined;
  }
}

function clientStreamEnd(role: ApplicationRole): object {
  return {
    type: "client-stream/end",
    payload: { roles: [familyOf(role.id)] },
  };
}
