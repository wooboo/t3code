import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Platform, View } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { serverEnvironment } from "../../state/server";
import { useVoiceHost } from "./useVoiceHost";
import { voiceSupport } from "./voiceSupport";

export function FullVoiceIcon({
  environmentId,
  selected = false,
}: {
  environmentId: EnvironmentId;
  selected?: boolean;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const voiceHost = useVoiceHost();
  const support = voiceSupport({
    sameEnvironment: (voiceHost.environmentId ?? environmentId) === environmentId,
    voice: config?.environment.capabilities.voice,
    callbacks: config?.environment.capabilities.voiceCallbacks,
    android: Platform.OS === "android",
  });
  if (support.label !== "Full voice") return null;
  return (
    <View
      accessible
      accessibilityLabel="Full voice"
      accessibilityHint="Calls and agent callbacks supported"
    >
      <SymbolView
        name="phone.fill"
        size={12}
        tintColorClassName={
          selected ? "accent-user-bubble-foreground" : "accent-foreground-secondary"
        }
        type="monochrome"
      />
    </View>
  );
}
