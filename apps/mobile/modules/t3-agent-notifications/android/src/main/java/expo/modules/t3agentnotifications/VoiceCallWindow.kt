package expo.modules.t3agentnotifications

import android.app.Activity
import android.os.Build
import android.view.WindowManager

/** Only the focused incoming-call screen may cover the keyguard; this does not unlock the phone. */
object VoiceCallWindow {
  fun setVisible(activity: Activity, visible: Boolean) {
    if (Build.VERSION.SDK_INT >= 27) {
      activity.setShowWhenLocked(visible)
      activity.setTurnScreenOn(visible)
    } else {
      @Suppress("DEPRECATION")
      val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
      if (visible) activity.window.addFlags(flags) else activity.window.clearFlags(flags)
    }
  }
}
