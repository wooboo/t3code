import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { EnvironmentId } from "@t3tools/contracts";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useVoiceHost() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const id = AsyncResult.isSuccess(preferences) ? preferences.value.voiceHostEnvironmentId : null;
  return {
    environmentId: id ? EnvironmentId.make(id) : null,
    select: (environmentId: EnvironmentId | null) =>
      save({ voiceHostEnvironmentId: environmentId }),
  };
}
