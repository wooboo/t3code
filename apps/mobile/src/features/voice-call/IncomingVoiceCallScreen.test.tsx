import { act } from "react";
import { Pressable } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
vi.mock("./VoiceEnvironmentContext", () => ({ VoiceEnvironmentContext: () => null }));
const phone = vi.hoisted(() => ({
  ringing: true,
  start: vi.fn(),
  navigate: vi.fn(),
  windowVisible: false,
}));
vi.mock("react-native", () => ({ View: "View", Pressable: "Pressable" }));
vi.mock("../../components/ui/AppText", () => ({ AppText: "Text" }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    useNavigation: () => ({ navigate: phone.navigate }),
    useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
  };
});
vi.mock("../../state/session", () => ({
  usePreparedConnection: () =>
    Option.some({
      httpBaseUrl: "https://t3.test",
      httpAuthorization: { _tag: "Bearer", token: "test" },
    }),
}));
vi.mock("./useVoiceCall", () => ({
  useVoiceCall: () => ({ supported: true, start: phone.start }),
}));
vi.mock("./VoiceCallPanel", () => ({ VoiceCallPanel: () => null }));
vi.mock("./callbackDevice", () => ({
  dismissIncomingCall: () => {
    phone.ringing = false;
  },
  setIncomingCallVisible: (visible: boolean) => {
    phone.windowVisible = visible;
  },
}));
import { IncomingVoiceCallScreen } from "./IncomingVoiceCallScreen";
let screen: ReactTestRenderer | undefined;
afterEach(async () => {
  if (screen) await act(async () => screen!.unmount());
  screen = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("opening an unanswered invitation keeps ringing; only answering starts the microphone and stops ringing", async () => {
  phone.ringing = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        id: "call",
        environmentId: "env",
        threadId: "thread",
        reason: "Test",
        context: "",
        status: "pending",
        expiresAt: Date.now() + 45000,
      }),
    ),
  );
  await act(async () => {
    screen = create(
      <IncomingVoiceCallScreen
        route={{
          params: { hostEnvironmentId: "host", callId: "call" },
        }}
      />,
    );
  });
  expect(phone.ringing).toBe(true);
  expect(phone.start).not.toHaveBeenCalled();
  const answer = screen!.root
    .findAllByType(Pressable)
    .find((node) => node.findAllByType(AppText).some((text) => text.props.children === "Odbierz"))!;
  await act(async () => answer.props.onPress());
  expect(phone.ringing).toBe(false);
  expect(phone.start).toHaveBeenCalledOnce();
});
it("expired invitations stop ringing and never start a voice session", async () => {
  phone.ringing = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        id: "call",
        environmentId: "env",
        threadId: "thread",
        reason: "Test",
        context: "",
        status: "missed",
        expiresAt: Date.now() - 1,
      }),
    ),
  );
  await act(async () => {
    screen = create(
      <IncomingVoiceCallScreen
        route={{
          params: { hostEnvironmentId: "host", callId: "call" },
        }}
      />,
    );
  });
  expect(phone.ringing).toBe(false);
  expect(phone.start).not.toHaveBeenCalled();
});
