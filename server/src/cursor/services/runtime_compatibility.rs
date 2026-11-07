//! Shares bounded runtime mismatch diagnostics with the desktop control API.
use std::sync::Arc;

use serde::Serialize;

#[derive(Clone, Default)]
pub struct RuntimeCompatibility {
    state: Arc<parking_lot::Mutex<RuntimeCompatibilityStatus>>,
}

#[derive(Clone, Default, Serialize)]
pub struct RuntimeCompatibilityStatus {
    pub mismatch_count: u64,
    pub last_detected_at_ms: Option<i64>,
}

impl RuntimeCompatibility {
    pub fn report_mismatch(&self) {
        let mut state = self.state.lock();
        state.mismatch_count = state.mismatch_count.saturating_add(1);
        state.last_detected_at_ms = Some(chrono::Utc::now().timestamp_millis());
    }

    pub fn status(&self) -> RuntimeCompatibilityStatus {
        self.state.lock().clone()
    }
}
