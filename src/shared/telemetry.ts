// APPEND-ONLY shared telemetry consent contract. This contains consent state only;
// analytics event names and properties deliberately remain private to main.

/** App-global, independently controlled telemetry choices. */
export interface TelemetryConsent {
  usageAnalytics: boolean;
  crashReporting: boolean;
  /** Native crash capture is active for this process (a new opt-in needs a restart). */
  crashReportingActive: boolean;
}

/** Untrusted renderer update accepted by the privacy IPC handler. */
export interface TelemetryConsentUpdate {
  usageAnalytics?: boolean;
  crashReporting?: boolean;
}
