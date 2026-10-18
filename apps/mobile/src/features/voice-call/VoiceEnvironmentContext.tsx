import { memo, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useEnvironments } from "../../state/environments";
import { useServerConfigs } from "../../state/entities";
import { voiceSupport } from "./voiceSupport";

export const VoiceEnvironmentContext = memo(function VoiceEnvironmentContext({
  environmentId,
  hostEnvironmentId,
  compact = false,
}: {
  environmentId: EnvironmentId;
  hostEnvironmentId: EnvironmentId;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { environments } = useEnvironments();
  const configs = useServerConfigs();
  const task = environments.find((environment) => environment.environmentId === environmentId);
  const host = environments.find((environment) => environment.environmentId === hostEnvironmentId);
  const capabilities = configs.get(hostEnvironmentId)?.environment.capabilities;
  const support = voiceSupport({
    sameEnvironment: environmentId === hostEnvironmentId,
    voice: capabilities?.voice,
    callbacks: capabilities?.voiceCallbacks,
    android: Platform.OS === "android",
  });
  const taskName =
    task?.label ?? configs.get(environmentId)?.environment.label ?? "Unknown environment";
  const hostName =
    host?.label ?? configs.get(hostEnvironmentId)?.environment.label ?? "Unknown environment";
  const taskAddress = task?.displayUrl?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <View className={compact ? "px-3" : "self-stretch"}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Task environment: ${taskName}, ${taskAddress ?? environmentId}. ${support.label}`}
        accessibilityHint="Show or hide environment details"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="min-h-11 flex-row items-center gap-2"
      >
        <Text className="min-w-0 flex-1 text-xs text-foreground-secondary" numberOfLines={1}>
          {taskAddress ?? taskName}
        </Text>
        <Text className="text-xs text-foreground-secondary">{support.label}</Text>
        <SymbolView
          name={expanded ? "chevron.up" : "chevron.down"}
          size={12}
          tintColorClassName="accent-foreground-secondary"
          type="monochrome"
        />
      </Pressable>
      {expanded ? (
        <View className="gap-2 pb-3">
          <Text className="text-xs text-foreground-secondary">
            Task environment: {taskName}
            {"\n"}
            {task?.displayUrl ?? environmentId}
          </Text>
          <Text className="text-xs text-foreground-secondary">
            Voice server: {hostName}
            {"\n"}
            {host?.displayUrl ?? hostEnvironmentId}
          </Text>
          <Text className="text-xs text-foreground-secondary">{support.detail}</Text>
        </View>
      ) : null}
    </View>
  );
});
