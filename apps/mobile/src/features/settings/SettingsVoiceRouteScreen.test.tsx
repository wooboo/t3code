import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import { SettingsVoiceRouteScreen } from "./SettingsVoiceRouteScreen";

vi.mock("../voice-call/CallbackPushSettings", () => ({ CallbackPushSettings: () => null }));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../voice-call/useVoiceHost", () => ({
  useVoiceHost: () => ({ environmentId: "env", select: vi.fn() }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "env", label: "Test" }] }),
}));
vi.mock("../../state/session", () => ({
  usePreparedConnection: () =>
    Option.some({
      httpBaseUrl: "https://voice.test",
      httpAuthorization: { _tag: "Bearer", token: "test" },
    }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: vi.fn() }) }));
vi.mock("../../components/ui/Menu", () => ({ Menu: "Menu" }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/ui/AppText", () => ({ AppText: "Text", AppTextInput: "TextInput" }));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: "Header" }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Switch: "Switch",
  View: "View",
}));

let root: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

it("saves and disables callbacks without writing or restarting read-only voice services", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const config = {
    llmApiType: "responses",
    llmUrl: "",
    llmModel: "test",
    sttUrl: "https://stt.test",
    sttModel: "test",
    ttsProvider: "elevenlabs",
    ttsUrl: "http://127.0.0.1:18092/v1",
    ttsModel: "test",
    ttsVoice: "test",
    ttsSampleRate: 16000,
    silenceMs: 500,
    interruptions: true,
  };
  const patches: boolean[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/agent-settings") && !init?.method)
      return Response.json({
        config,
        active: config,
        writable: false,
        restartRequired: false,
        llmKeyConfigured: false,
      });
    if (url.endsWith("/t3-global-settings")) {
      if (init?.method === "PATCH") patches.push(JSON.parse(String(init.body)).autoCallback);
      return Response.json({
        config: { autoCallback: false, instructions: { global: "" }, modelSelection: null },
        catalog: { providers: [] },
      });
    }
    throw Error("Service configuration must not be written or restarted");
  });
  vi.stubGlobal("fetch", fetcher);
  await act(() => {
    root = create(<SettingsVoiceRouteScreen />);
  });
  const callbackSwitch = () =>
    root!.root.findByProps({
      accessibilityLabel: "Oddzwaniaj automatycznie po zakończeniu zadania",
    });
  const save = () =>
    root!.root
      .findAllByProps({ accessibilityRole: "button" })
      .find((node) => typeof node.props.onPress === "function")!;
  for (const enabled of [true, false]) {
    await act(() => callbackSwitch().props.onValueChange(enabled));
    expect(save().props.disabled).toBe(false);
    await act(() => save().props.onPress());
    expect(save().props.disabled).toBe(true);
    expect(callbackSwitch().props.value).toBe(enabled);
  }
  expect(patches).toEqual([true, false]);
  expect(fetcher).toHaveBeenCalledTimes(4);
});
