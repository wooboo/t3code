import { groupVoiceTranscript } from "@t3tools/client-runtime/voice-input";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, View, useWindowDimensions, type ScrollView } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  Easing,
  ReduceMotion,
  interpolate,
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { Menu as ControlPillMenu } from "../../components/ui/Menu";
import type { VoiceAudioRoute } from "./voiceCallController";
import type { VoiceCallHandle } from "./useVoiceCall";
import { VoiceEnvironmentContext } from "./VoiceEnvironmentContext";

const SHEET_TIMING = {
  duration: 220,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;

const AUDIO_ROUTE_UI = {
  earpiece: { label: "Słuchawka telefonu", icon: "phone.fill" },
  speaker: { label: "Głośnik", icon: "speaker.wave.2.fill" },
  bluetooth: { label: "Bluetooth", icon: "airpodspro" },
  headset: { label: "Słuchawki", icon: "headphones" },
  default: { label: "system default", icon: "slider.horizontal.3" },
} as const satisfies Record<string, { label: string; icon: AppSymbolName }>;

export function VoiceCallPanel(props: {
  call: VoiceCallHandle;
  canStart: boolean;
  onClose: () => void;
}) {
  const { call } = props;
  const [historyVisible, setHistoryVisible] = useState(false);
  const messages = useMemo(
    () => (historyVisible ? groupVoiceTranscript(call.state.messages) : []),
    [call.state.messages, historyVisible],
  );
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [routeError, setRouteError] = useState("");
  const transcriptScroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const transcriptHeight = useRef(0);
  const viewportHeight = useRef(0);
  const scrollToLatest = useCallback(() => {
    if (viewportHeight.current === 0 || transcriptHeight.current === 0) return;
    transcriptScroll.current?.scrollTo({
      y: Math.max(0, transcriptHeight.current - viewportHeight.current),
      animated: false,
    });
  }, []);
  useLayoutEffect(scrollToLatest, [call.state.messages, scrollToLatest]);
  const canStart = call.supported && props.canStart;
  const currentRoute = call.audioRoute;
  const currentRouteUi = currentRoute
    ? AUDIO_ROUTE_UI[currentRoute]
    : { label: "Wyjście systemowe", icon: "slider.horizontal.3" as const };
  const sheetHeight = useSharedValue(height);
  const translateY = useSharedValue(height);
  const scrollY = useSharedValue(0);
  const headerBottom = useSharedValue(0);
  const dragAllowed = useSharedValue(false);
  const voiceLevel = useDerivedValue(() =>
    withTiming(call.state.active && !call.state.muted ? call.audioLevel.value : 0, {
      duration: 90,
      reduceMotion: ReduceMotion.System,
    }),
  );

  useEffect(() => {
    translateY.value = withTiming(0, SHEET_TIMING);
  }, [translateY]);

  const closeSheet = useCallback(() => {
    translateY.value = withTiming(sheetHeight.value, SHEET_TIMING, (finished) => {
      if (finished) runOnJS(props.onClose)();
    });
  }, [props.onClose, sheetHeight, translateY]);

  const dismissGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-12, 12])
        .failOffsetX([-28, 28])
        .onBegin((event) => {
          // The header stays draggable even when auto-scroll has moved the transcript down.
          dragAllowed.value =
            !historyVisible || event.y <= headerBottom.value || scrollY.value <= 0;
        })
        .onUpdate((event) => {
          if (dragAllowed.value) translateY.value = Math.max(0, event.translationY);
        })
        .onEnd((event) => {
          if (!dragAllowed.value) return;
          if (
            event.translationY > Math.min(140, sheetHeight.value * 0.28) ||
            event.velocityY > 900
          ) {
            translateY.value = withTiming(sheetHeight.value, SHEET_TIMING, (finished) => {
              if (finished) runOnJS(props.onClose)();
            });
          } else {
            translateY.value = withSpring(0, {
              damping: 28,
              stiffness: 300,
              mass: 0.8,
              reduceMotion: ReduceMotion.System,
            });
          }
        }),
    [dragAllowed, headerBottom, historyVisible, props.onClose, scrollY, sheetHeight, translateY],
  );
  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateY.value, [0, Math.max(1, sheetHeight.value)], [1, 0]),
  }));
  const outerGlowStyle = useAnimatedStyle(() => {
    const level = Math.min(1, voiceLevel.value * 3);
    return {
      opacity: call.state.active && !call.state.muted ? 0.08 + level * 0.3 : 0,
      transform: [{ scale: 1.05 + level * 0.65 }],
    };
  });
  const pulseStyle = useAnimatedStyle(() => {
    const level = Math.min(1, voiceLevel.value * 3);
    return {
      opacity: call.state.active && !call.state.muted ? 0.16 + level * 0.34 : 0,
      transform: [{ scale: 1 + level * 0.38 }],
    };
  });
  const microphoneStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + Math.min(1, voiceLevel.value * 3) * 0.1 }],
  }));

  async function selectAudioRoute(route: VoiceAudioRoute) {
    setRouteError("");
    try {
      await call.setAudioRoute(route);
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "Could not change the audio output.");
    }
  }

  return (
    <Modal visible animationType="none" transparent onRequestClose={closeSheet}>
      <GestureHandlerRootView style={{ flex: 1, justifyContent: "flex-end" }}>
        <Animated.View className="absolute inset-0 bg-black/35" style={backdropStyle}>
          <Pressable
            accessibilityLabel="Close voice panel"
            accessibilityRole="button"
            className="flex-1"
            onPress={closeSheet}
          />
        </Animated.View>
        <GestureDetector gesture={dismissGesture}>
          <Animated.View
            className="rounded-t-3xl bg-card px-4 pt-2"
            onLayout={(event) => {
              sheetHeight.value = event.nativeEvent.layout.height;
            }}
            style={[
              sheetStyle,
              {
                maxHeight: Math.min(height - insets.top - 16, height * 0.82),
                paddingBottom: Math.max(insets.bottom, 16),
              },
            ]}
          >
            <View
              onLayout={(event) => {
                const { y, height: headerHeight } = event.nativeEvent.layout;
                headerBottom.value = y + headerHeight;
              }}
            >
              <View className="h-5 items-center justify-center" accessibilityElementsHidden>
                <View className="h-1 w-10 rounded-full bg-foreground-muted/40" />
              </View>
              <View className="flex-row items-center justify-between">
                <Text className="text-base font-t3-medium">Voice call</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close voice panel"
                  onPress={closeSheet}
                  className="size-11 items-center justify-center"
                >
                  <SymbolView
                    name="xmark"
                    size={18}
                    tintColorClassName="accent-icon"
                    type="monochrome"
                  />
                </Pressable>
              </View>
            </View>
            <Text accessibilityLiveRegion="polite" className="my-2 text-sm text-foreground-muted">
              {call.state.muted ? "Microphone muted" : call.state.status}
            </Text>
            <VoiceEnvironmentContext
              environmentId={call.environmentId}
              hostEnvironmentId={call.hostEnvironmentId}
            />
            {call.state.error || call.unsupportedReason || routeError ? (
              <Text accessibilityRole="alert" className="mb-2 text-sm text-danger">
                {call.state.error || call.unsupportedReason || routeError}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: historyVisible }}
              onPress={() => {
                scrollY.value = 0;
                transcriptHeight.current = 0;
                viewportHeight.current = 0;
                setHistoryVisible((visible) => !visible);
              }}
              className="min-h-11 justify-center py-3"
            >
              <Text className="text-sm font-t3-medium">
                {historyVisible ? "Ukryj historię" : "Pokaż historię"}
              </Text>
            </Pressable>
            {historyVisible ? (
              <Animated.ScrollView
                ref={transcriptScroll}
                className="shrink"
                style={{ flexShrink: 1 }}
                keyboardShouldPersistTaps="handled"
                contentContainerClassName="gap-3 pb-2"
                onScroll={scrollHandler}
                scrollEventThrottle={16}
                onLayout={(event) => {
                  viewportHeight.current = event.nativeEvent.layout.height;
                  scrollToLatest();
                }}
              >
                <View
                  className="gap-4 py-2"
                  onLayout={(event) => {
                    // Native text is measured after React's effects; follow its final height.
                    transcriptHeight.current = event.nativeEvent.layout.height;
                    scrollToLatest();
                  }}
                >
                  {call.state.messages.length === 0 ? (
                    <Text className="px-4 py-10 text-center text-sm text-foreground-secondary">
                      Your conversation with the agent will appear here.
                    </Text>
                  ) : null}
                  {messages.map((message) => (
                    <View
                      key={message.id}
                      className={`max-w-[88%] ${message.role === "user" ? "self-end" : "self-start"}`}
                    >
                      <Text
                        className={`mb-1 px-3 text-xs text-foreground-secondary ${message.role === "user" ? "text-right" : "text-left"}`}
                      >
                        {message.role === "user" ? "You" : "Voice"}
                      </Text>
                      <View
                        className={`rounded-2xl px-4 py-3 ${message.role === "user" ? "rounded-br-md bg-primary" : "rounded-bl-md bg-subtle"}`}
                      >
                        <Text
                          selectable
                          className={`text-sm leading-6 ${message.role === "user" ? "text-primary-foreground" : "text-foreground"}`}
                        >
                          {message.content}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
                <Text className="text-xs text-foreground-muted">
                  Closing this panel keeps the call connected. Switching threads ends the call; the
                  coding task can continue.
                </Text>
              </Animated.ScrollView>
            ) : null}
            <View className="relative h-32 items-center pt-1">
              <View className="relative h-20 w-full items-center justify-center">
                {call.state.active ? (
                  <ControlPillMenu
                    title="Wyjście audio"
                    accessibilityLabel={`Wyjście audio: ${currentRouteUi.label}`}
                    className="absolute left-3"
                    actions={call.audioRoutes.map((route) => ({
                      id: route,
                      title: AUDIO_ROUTE_UI[route].label,
                      state: currentRoute === route ? "on" : "off",
                    }))}
                    onPressAction={({ nativeEvent }) => {
                      const route = call.audioRoutes.find((route) => route === nativeEvent.event);
                      if (route) void selectAudioRoute(route);
                    }}
                  >
                    <View className="size-12 items-center justify-center rounded-full bg-subtle">
                      <SymbolView
                        name={currentRouteUi.icon}
                        size={20}
                        tintColorClassName="accent-icon"
                        type="monochrome"
                      />
                    </View>
                  </ControlPillMenu>
                ) : null}
                <Animated.View
                  className="absolute size-20 rounded-full bg-danger"
                  style={outerGlowStyle}
                />
                <Animated.View
                  className="absolute size-16 rounded-full bg-danger"
                  style={pulseStyle}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={call.state.active ? "End call" : "Start call"}
                  accessibilityState={{ disabled: !call.state.active && !canStart }}
                  disabled={!call.state.active && !canStart}
                  onPress={call.state.active ? call.stop : () => void call.start()}
                  className={
                    call.state.active
                      ? call.state.muted
                        ? "size-16 items-center justify-center rounded-full bg-subtle"
                        : "size-16 items-center justify-center rounded-full bg-danger"
                      : "size-16 items-center justify-center rounded-full bg-primary disabled:opacity-50"
                  }
                >
                  <Animated.View style={microphoneStyle}>
                    <SymbolView
                      name={call.state.active ? "stop.fill" : "mic"}
                      size={24}
                      tintColorClassName={
                        call.state.active
                          ? call.state.muted
                            ? "accent-icon"
                            : "accent-danger-foreground"
                          : "accent-primary-foreground"
                      }
                      type="monochrome"
                    />
                  </Animated.View>
                </Pressable>
                {call.state.active ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={call.state.muted ? "Unmute microphone" : "Mute microphone"}
                    accessibilityState={{ selected: call.state.muted }}
                    onPress={() => void call.toggleMute()}
                    className="absolute right-3 size-12 items-center justify-center rounded-full bg-subtle"
                  >
                    <SymbolView
                      name={call.state.muted ? "mic.slash" : "mic"}
                      size={20}
                      tintColorClassName="accent-icon"
                      type="monochrome"
                    />
                  </Pressable>
                ) : null}
              </View>
              <Text className="text-sm font-t3-medium">
                {call.state.active ? "End call" : "Start call"}
              </Text>
            </View>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}
