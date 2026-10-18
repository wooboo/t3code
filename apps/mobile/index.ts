// Must stay first: the render counter wraps the DevTools hook before any React commit.
import "./src/features/development/render-counter-entry";
import { registerGlobals } from "@livekit/react-native";
import { registerRootComponent } from "expo";
import "react-native-gesture-handler";
import { AppRegistry, LogBox } from "react-native";
import { featureFlags } from "react-native-screens";

import App from "./src/App";
import { getVoiceAudio } from "./src/native/voiceAudio";

// Required for react-native-screens' iOS FormSheet sizing fix when a nested
// native stack is rendered inside a non-fitToContents formSheet.
featureFlags.experiment.synchronousScreenUpdatesEnabled = true;

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  LogBox.ignoreAllLogs();
}

AppRegistry.registerHeadlessTask(
  "T3VoiceCall",
  () =>
    async ({ generation }: { generation: number }) => {
      await getVoiceAudio()?.waitForCallEnd?.(generation);
    },
);

registerGlobals();
registerRootComponent(App);
