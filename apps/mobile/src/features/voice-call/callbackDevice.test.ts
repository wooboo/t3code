import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
  state: { enabled: false, error: "", subscription: undefined as unknown },
  native: {
    configureVoiceCalls: vi.fn(),
    registerVoiceFcm: vi.fn(),
    unregisterVoiceFcm: vi.fn(),
    registerVoicePush: vi.fn(),
    unregisterVoicePush: vi.fn(),
    addListener: vi.fn(),
  },
  permissions: vi.fn(async () => ({ granted: true })),
  requestPermissions: vi.fn(async () => ({ granted: true })),
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { scheme: "t3code-dev" } } }));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({
    ...mocks.native,
    getVoicePushState: () => JSON.stringify(mocks.state),
  }),
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: mocks.permissions,
  requestPermissionsAsync: mocks.requestPermissions,
}));
vi.mock("../../persistence/imperative", () => ({
  loadOrCreateAgentAwarenessDeviceId: async () => "phone",
}));
const subscription = {
  endpoint: "https://my-push.test/up-secret",
  keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
};
const config = () => Response.json({ vapidPublicKey: "B".repeat(87) });
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.state = { enabled: false, error: "", subscription: undefined };
  mocks.permissions.mockResolvedValue({ granted: true });
  mocks.native.registerVoicePush.mockResolvedValue(JSON.stringify(subscription));
});
afterEach(() => vi.unstubAllGlobals());

it("does not enable callbacks or open a distributor on routine refresh", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const { registerCallbackDevice } = await import("./callbackDevice");
  await registerCallbackDevice("https://voice.test", "bearer", "host");
  expect(fetcher).not.toHaveBeenCalled();
  expect(mocks.native.registerVoicePush).not.toHaveBeenCalled();
});
it("registers the chosen encrypted subscription with the authenticated voice host", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(config())
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  const { registerCallbackDevice } = await import("./callbackDevice");
  await registerCallbackDevice("https://voice.test/prefix/", "bearer", "host", {
    enable: true,
    pick: true,
  });
  expect(mocks.native.registerVoicePush).toHaveBeenCalledWith("host", "B".repeat(87), true, true);
  const [url, request] = fetcher.mock.calls[1]!;
  expect(String(url)).toBe("https://voice.test/prefix/voice/livekit/device");
  expect(request.headers.authorization).toBe("Bearer bearer");
  expect(JSON.parse(request.body)).toEqual({
    deviceId: "phone",
    hostEnvironmentId: "host",
    subscription,
  });
});
it("a late distributor reply cannot re-enable callbacks after disabling", async () => {
  let complete!: (value: string) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  mocks.native.registerVoicePush.mockImplementation(() => {
    began();
    return new Promise<string>((resolve) => {
      complete = resolve;
    });
  });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(config())
    .mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  const { registerCallbackDevice, unregisterCallbackDevice } = await import("./callbackDevice");
  const registration = registerCallbackDevice("https://voice.test", "bearer", "host", {
    enable: true,
  });
  await started;
  const disabled = unregisterCallbackDevice("https://voice.test", "bearer", "host");
  complete(JSON.stringify(subscription));
  await Promise.all([registration, disabled]);
  expect(mocks.native.unregisterVoicePush).toHaveBeenCalledWith("host");
  expect(fetcher.mock.calls.some(([, init]) => init.method === "POST")).toBe(false);
  expect(fetcher.mock.calls.at(-1)![1].method).toBe("DELETE");
});
it("endpoint rotation is synchronized without opening the distributor again", async () => {
  mocks.state = { enabled: true, error: "", subscription };
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  const { syncCallbackPush } = await import("./callbackDevice");
  await syncCallbackPush("https://voice.test", "bearer", "host");
  expect(mocks.native.registerVoicePush).not.toHaveBeenCalled();
  expect(JSON.parse(fetcher.mock.calls[0]![1].body).subscription).toEqual(subscription);
});
it("failed server registration is surfaced instead of reporting success", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(config())
      .mockResolvedValue(new Response(null, { status: 503 })),
  );
  const { registerCallbackDevice } = await import("./callbackDevice");
  await expect(
    registerCallbackDevice("https://voice.test", "bearer", "host", { enable: true }),
  ).rejects.toThrow("Nie udało się zapisać telefonu");
});

it("registers an FCM token and retires UnifiedPush only after the server accepts it", async () => {
  mocks.state = { enabled: true, error: "", subscription };
  mocks.native.registerVoiceFcm.mockResolvedValue("fcm-device-token");
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ provider: "fcm", projectId: "voice-project" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  const { registerCallbackDevice } = await import("./callbackDevice");
  await registerCallbackDevice("https://voice.test", "bearer", "host", { enable: true });
  expect(mocks.native.registerVoiceFcm).toHaveBeenCalledWith("host", "voice-project");
  expect(mocks.native.registerVoicePush).not.toHaveBeenCalled();
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
    deviceId: "phone",
    hostEnvironmentId: "host",
    provider: "fcm",
    projectId: "voice-project",
    token: "fcm-device-token",
  });
  expect(mocks.native.unregisterVoicePush).toHaveBeenCalledWith("host");
});
it("failed FCM registration does not retire the existing UnifiedPush subscription", async () => {
  mocks.native.registerVoiceFcm.mockResolvedValue("fcm-device-token");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ provider: "fcm", projectId: "voice-project" }))
      .mockResolvedValueOnce(new Response(null, { status: 503 })),
  );
  const { registerCallbackDevice } = await import("./callbackDevice");
  await expect(
    registerCallbackDevice("https://voice.test", "bearer", "host", { enable: true }),
  ).rejects.toThrow("Nie udało się zapisać telefonu");
  expect(mocks.native.unregisterVoicePush).not.toHaveBeenCalled();
});
