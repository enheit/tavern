import { vi } from "vitest";

// Shared electron mock for the desktop main/preload unit tests. Each test file replaces the
// `electron` module with this via `vi.mock("electron", () => import("./electron-mock"))` and calls
// `resetElectronMock()` in beforeEach. Types here are the mock's own convenience types — the SUT is
// type-checked against the real electron.d.ts, never against this file.

export type FakeInvokeEvent = { senderFrame: { url: string } | null };
type InvokeHandler = (event: FakeInvokeEvent, ...args: unknown[]) => unknown;
type PermissionRequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
) => void;
type PermissionCheckHandler = (webContents: unknown, permission: string) => boolean;
type DisplayMediaHandler = (request: unknown, callback: (streams: unknown) => void) => void;
type AppListener = (...args: unknown[]) => void;

export type FakeSource = {
  id: string;
  name: string;
  thumbnail: { toDataURL: () => string };
  appIcon: { toDataURL: () => string } | null;
};

// ---- registries the tests inspect / drive -------------------------------------------------------
export const ipcMainHandlers = new Map<string, InvokeHandler>();
export const rendererListeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
export const exposedInMainWorld = new Map<string, unknown>();
export const appliedSwitches: Array<{ name: string; value?: string }> = [];
const appEventHandlers = new Map<string, AppListener[]>();

export const state = {
  userDataDir: "/tmp/tavern-mock",
  appPath: "/tmp/tavern-app",
  version: "1.0.0",
  isPackaged: false,
  singleInstanceLock: true,
  permissionRequestHandler: null as PermissionRequestHandler | null,
  permissionCheckHandler: null as PermissionCheckHandler | null,
  displayMediaHandler: null as DisplayMediaHandler | null,
  invokeResults: new Map<string, unknown>(),
  registeredSchemes: [] as unknown[],
  protocolHandlers: new Map<string, (request: Request) => Response | Promise<Response>>(),
  sources: [] as FakeSource[],
  mediaAccessStatus: "granted" as string,
};

export function emitAppEvent(name: string, ...args: unknown[]): void {
  for (const listener of appEventHandlers.get(name) ?? []) listener(...args);
}

export function emitRendererEvent(channel: string, ...args: unknown[]): void {
  const listener = rendererListeners.get(channel);
  if (listener !== undefined) listener({}, ...args);
}

// ---- electron surface ---------------------------------------------------------------------------
export const app = {
  getPath: vi.fn((name: string) => (name === "userData" ? state.userDataDir : `/tmp/${name}`)),
  setPath: vi.fn((name: string, value: string) => {
    if (name === "userData") state.userDataDir = value;
  }),
  getAppPath: vi.fn(() => state.appPath),
  getVersion: vi.fn(() => state.version),
  get isPackaged() {
    return state.isPackaged;
  },
  requestSingleInstanceLock: vi.fn(() => state.singleInstanceLock),
  on: vi.fn((event: string, listener: AppListener) => {
    const list = appEventHandlers.get(event) ?? [];
    list.push(listener);
    appEventHandlers.set(event, list);
  }),
  quit: vi.fn(),
  exit: vi.fn(),
  relaunch: vi.fn(),
  setBadgeCount: vi.fn(),
  setAppUserModelId: vi.fn(),
  whenReady: vi.fn(() => Promise.resolve()),
  commandLine: {
    appendSwitch: vi.fn((name: string, value?: string) => {
      appliedSwitches.push(value === undefined ? { name } : { name, value });
    }),
  },
};

export const ipcMain = {
  handle: vi.fn((channel: string, handler: InvokeHandler) => {
    ipcMainHandlers.set(channel, handler);
  }),
};

export const ipcRenderer = {
  invoke: vi.fn((channel: string, ..._args: unknown[]) =>
    Promise.resolve(state.invokeResults.get(channel)),
  ),
  on: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
    rendererListeners.set(channel, listener);
  }),
};

export const contextBridge = {
  exposeInMainWorld: vi.fn((key: string, value: unknown) => {
    exposedInMainWorld.set(key, value);
  }),
};

export const protocol = {
  registerSchemesAsPrivileged: vi.fn((schemes: unknown[]) => {
    state.registeredSchemes = schemes;
  }),
  handle: vi.fn((scheme: string, handler: (request: Request) => Response | Promise<Response>) => {
    state.protocolHandlers.set(scheme, handler);
  }),
};

const defaultSession = {
  setPermissionRequestHandler: vi.fn((handler: PermissionRequestHandler) => {
    state.permissionRequestHandler = handler;
  }),
  setPermissionCheckHandler: vi.fn((handler: PermissionCheckHandler) => {
    state.permissionCheckHandler = handler;
  }),
  setDisplayMediaRequestHandler: vi.fn((handler: DisplayMediaHandler) => {
    state.displayMediaHandler = handler;
  }),
};

export const session = { defaultSession };

export const desktopCapturer = {
  getSources: vi.fn((_opts: unknown) => Promise.resolve<FakeSource[]>(state.sources)),
};

// venmic.ts imports this; its tests inject a fake host via deps.fork, so the real fork must never
// be reached — throwing keeps an accidental reach loud instead of silently undefined.
export const utilityProcess = {
  fork: vi.fn(() => {
    throw new Error("mock utilityProcess.fork not configured");
  }),
};

export const shell = {
  openExternal: vi.fn((_url: string) => Promise.resolve()),
};

// ---- tray ---------------------------------------------------------------------------------------
export type MenuItemTemplate = {
  label?: string;
  type?: string;
  click?: () => void;
};

export type FakeNativeImage = {
  dataUrl: string;
  template: boolean;
  resize: (options: unknown) => FakeNativeImage;
  setTemplateImage: (value: boolean) => void;
};

export const nativeImage = {
  createFromDataURL: vi.fn((dataUrl: string): FakeNativeImage => {
    const image: FakeNativeImage = {
      dataUrl,
      template: false,
      resize: vi.fn(() => image),
      setTemplateImage: vi.fn((value: boolean) => {
        image.template = value;
      }),
    };
    return image;
  }),
};

export const Menu = {
  buildFromTemplate: vi.fn((template: MenuItemTemplate[]) => ({ template })),
};

export class Tray {
  static instances: Tray[] = [];
  readonly image: unknown;
  toolTip: string | null = null;
  contextMenu: { template: MenuItemTemplate[] } | null = null;
  readonly handlers = new Map<string, () => void>();
  setToolTip = vi.fn((tip: string) => {
    this.toolTip = tip;
  });
  setContextMenu = vi.fn((menu: { template: MenuItemTemplate[] }) => {
    this.contextMenu = menu;
  });
  destroy = vi.fn();

  constructor(image: unknown) {
    this.image = image;
    Tray.instances.push(this);
  }

  on(event: string, listener: () => void): this {
    this.handlers.set(event, listener);
    return this;
  }

  emit(event: string): void {
    this.handlers.get(event)?.();
  }
}

export const systemPreferences = {
  getMediaAccessStatus: vi.fn((_mediaType: string) => state.mediaAccessStatus),
};

export const safeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  setUsePlainTextEncryption: vi.fn(),
  encryptString: vi.fn((plain: string) => Buffer.from(`enc:${plain}`, "utf8")),
  decryptString: vi.fn((buf: Buffer) => {
    const text = buf.toString("utf8");
    if (!text.startsWith("enc:")) throw new Error("mock safeStorage: cannot decrypt");
    return text.slice(4);
  }),
};

export class Notification {
  static instances: Notification[] = [];
  static isSupported = vi.fn(() => true);
  readonly options: { title?: string; body?: string };
  private readonly listeners = new Map<string, () => void>();
  show = vi.fn();

  constructor(options: { title?: string; body?: string }) {
    this.options = options;
    Notification.instances.push(this);
  }

  on(event: string, listener: () => void): this {
    this.listeners.set(event, listener);
    return this;
  }

  emit(event: string): void {
    this.listeners.get(event)?.();
  }
}

export class FakeWebContents {
  send = vi.fn();
  readonly handlers = new Map<string, (...args: unknown[]) => void>();
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null;

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.handlers.set(event, listener);
    return this;
  }

  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
    this.windowOpenHandler = handler;
  }
}

export class BrowserWindow {
  static instances: BrowserWindow[] = [];
  readonly options: unknown;
  readonly webContents = new FakeWebContents();
  private readonly handlers = new Map<string, (...args: unknown[]) => void>();
  minimized = false;
  visible = true;
  show = vi.fn(() => {
    this.visible = true;
  });
  hide = vi.fn(() => {
    this.visible = false;
  });
  isVisible = vi.fn(() => this.visible);
  focus = vi.fn();
  restore = vi.fn(() => {
    this.minimized = false;
  });
  isMinimized = vi.fn(() => this.minimized);
  loadURL = vi.fn(() => Promise.resolve());

  constructor(options: unknown) {
    this.options = options;
    BrowserWindow.instances.push(this);
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    this.handlers.set(event, listener);
    return this;
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.handlers.set(event, listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.(...args);
  }
}

export function resetElectronMock(): void {
  ipcMainHandlers.clear();
  rendererListeners.clear();
  exposedInMainWorld.clear();
  appEventHandlers.clear();
  appliedSwitches.length = 0;
  Notification.instances.length = 0;
  Notification.isSupported.mockReset();
  Notification.isSupported.mockReturnValue(true);
  BrowserWindow.instances.length = 0;
  Tray.instances.length = 0;
  state.userDataDir = "/tmp/tavern-mock";
  state.appPath = "/tmp/tavern-app";
  state.version = "1.0.0";
  state.isPackaged = false;
  state.singleInstanceLock = true;
  state.permissionRequestHandler = null;
  state.permissionCheckHandler = null;
  state.displayMediaHandler = null;
  state.invokeResults.clear();
  state.registeredSchemes = [];
  state.protocolHandlers.clear();
  state.sources = [];
  state.mediaAccessStatus = "granted";
  vi.clearAllMocks();
}
