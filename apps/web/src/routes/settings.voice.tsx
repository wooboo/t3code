import { createFileRoute } from "@tanstack/react-router";
import { VoiceSettingsPage } from "../components/settings/VoiceSettingsPage";

export const Route = createFileRoute("/settings/voice")({
  component: VoiceSettingsPage,
});
