import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { VoiceCallHandle } from "./useVoiceCall";
vi.mock("./VoiceEnvironmentContext", () => ({ VoiceEnvironmentContext: () => null }));
vi.mock("../../components/ui/Menu", () => ({ Menu: "ControlPillMenu" }));

type Drag = { translationY: number; velocityY: number; y: number };
const gesture = vi.hoisted(() => ({
  begin: (_event: Drag) => {},
  update: (_event: Drag) => {},
  end: (_event: Drag) => {},
}));
vi.mock("react-native", () => ({
  Modal: "Modal",
  Pressable: "Pressable",
  View: "View",
  useWindowDimensions: () => ({ height: 800 }),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: "Symbol" }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: "GestureRoot",
  GestureDetector: "GestureDetector",
  Gesture: {
    Pan: () => {
      const pan = {
        activeOffsetY: () => pan,
        failOffsetX: () => pan,
        onBegin: (fn: typeof gesture.begin) => {
          gesture.begin = fn;
          return pan;
        },
        onUpdate: (fn: typeof gesture.update) => {
          gesture.update = fn;
          return pan;
        },
        onEnd: (fn: typeof gesture.end) => {
          gesture.end = fn;
          return pan;
        },
      };
      return pan;
    },
  },
}));
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  return {
    default: { View: "AnimatedView", ScrollView: "ScrollView" },
    Easing: { out: () => 0, cubic: 0 },
    ReduceMotion: { System: 0 },
    useSharedValue: (value: number) => useRef({ value }).current,
    useDerivedValue: () => ({ value: 0 }),
    useAnimatedStyle: () => ({}),
    useAnimatedScrollHandler: (fn: unknown) => fn,
    runOnJS: (fn: unknown) => fn,
    withTiming: (value: number, _options: unknown, done?: (finished: boolean) => void) => {
      done?.(true);
      return value;
    },
    withSpring: (value: number) => value,
    interpolate: () => 0,
  };
});
import { VoiceCallPanel } from "./VoiceCallPanel";

let root: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});
it.each([
  { scroll: 400, startY: 10, distance: 180, closes: true },
  { scroll: 400, startY: 200, distance: 180, closes: false },
  { scroll: 0, startY: 200, distance: 180, closes: true },
  { scroll: 400, startY: 10, distance: 20, closes: false },
  { scroll: 400, startY: 10, distance: -180, closes: false },
])(
  "dismiss gesture: $scroll scroll, $startY start, $distance drag",
  async ({ scroll, startY, distance, closes }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onClose = vi.fn();
    const stop = vi.fn();
    const call = {
      state: { active: true, muted: false, status: "Listening", error: "", messages: [] },
      supported: true,
      unsupportedReason: null,
      audioLevel: { value: 0 },
      audioRoutes: [],
      audioRoute: null,
      stop,
      start: vi.fn(),
      toggleMute: vi.fn(),
      setAudioRoute: vi.fn(),
    } as unknown as VoiceCallHandle;
    await act(() => {
      root = create(<VoiceCallPanel call={call} canStart onClose={onClose} />);
    });
    await act(() => {
      root!.root.findByProps({ children: "Pokaż historię" }).parent!.props.onPress();
    });
    const title = root!.root.findByProps({ children: "Voice call" });
    // Header measurement is supplied by Android; older code did not measure it.
    title.parent?.parent?.props.onLayout?.({ nativeEvent: { layout: { y: 8, height: 64 } } });
    const scrollView = root!.root.findByType("ScrollView" as never);
    scrollView.props.onScroll({ contentOffset: { y: scroll } });
    const event = { y: startY, translationY: distance, velocityY: 0 };
    await act(() => {
      gesture.begin(event);
      gesture.update(event);
      gesture.end(event);
    });
    expect(onClose).toHaveBeenCalledTimes(closes ? 1 : 0);
    expect(stop).not.toHaveBeenCalled();
  },
);

it("appends resumed speech in the existing bubble and separates the next exchange", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const first = { id: "user:a", role: "user", content: "Sprawdź plik" };
  const call = {
    state: { active: true, muted: false, status: "Listening", error: "", messages: [first] },
    supported: true,
    unsupportedReason: null,
    audioLevel: { value: 0 },
    audioRoutes: [],
    audioRoute: null,
    stop: vi.fn(),
    start: vi.fn(),
    toggleMute: vi.fn(),
    setAudioRoute: vi.fn(),
  } as unknown as VoiceCallHandle;
  const onClose = vi.fn();
  await act(() => {
    root = create(<VoiceCallPanel call={call} canStart onClose={onClose} />);
  });
  expect(root!.root.findAllByProps({ children: "Sprawdź plik" })).toHaveLength(0);
  await act(() => {
    root!.root.findByProps({ children: "Pokaż historię" }).parent!.props.onPress();
  });
  expect(root!.root.findAllByProps({ children: "Sprawdź plik" })).toHaveLength(1);
  call.state = {
    ...call.state,
    messages: [first, { id: "user:b", role: "user", content: "i dodaj test" }],
  };
  await act(() => {
    root!.update(<VoiceCallPanel call={call} canStart onClose={onClose} />);
  });
  expect(root!.root.findAllByProps({ children: "You" })).toHaveLength(1);
  expect(root!.root.findAllByProps({ children: "Sprawdź plik i dodaj test" })).toHaveLength(1);
  call.state = {
    ...call.state,
    messages: [
      ...call.state.messages,
      { id: "assistant:a", role: "assistant", content: "Dobrze" },
      { id: "user:c", role: "user", content: "Jeszcze jedno" },
    ],
  };
  await act(() => {
    root!.update(<VoiceCallPanel call={call} canStart onClose={onClose} />);
  });
  expect(root!.root.findAllByProps({ children: "You" })).toHaveLength(2);
  await act(() => {
    root!.root.findByProps({ children: "Ukryj historię" }).parent!.props.onPress();
  });
  expect(root!.root.findAllByProps({ children: "You" })).toHaveLength(0);
  expect(root!.root.findAllByProps({ accessibilityLabel: "End call" })).toHaveLength(1);
  expect(call.stop).not.toHaveBeenCalled();
  await act(() => {
    root!.root.findByProps({ children: "Pokaż historię" }).parent!.props.onPress();
  });
  expect(root!.root.findAllByProps({ children: "You" })).toHaveLength(2);
});
