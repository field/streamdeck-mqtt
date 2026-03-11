const idleTimers = {};
const continuousTimers = {};

function clearContinuous(context) {
    const state = continuousTimers[context];
    if (!state) return;
    if (state.timer) {
        clearTimeout(state.timer);
    }
    delete continuousTimers[context];
}

function scheduleContinuous(context) {
    const state = continuousTimers[context];
    if (!state) return;

    const now = Date.now();
    let delay = state.nextAt - now;
    if (!Number.isFinite(delay) || delay < 0) {
        delay = 0;
    }

    state.timer = setTimeout(() => {
        const current = continuousTimers[context];
        if (!current || current.token !== state.token) return;

        self.postMessage({
            type: "continuousTick",
            payload: { context, token: current.token }
        });

        current.nextAt += current.intervalMs;
        const nowAfter = Date.now();
        if (current.nextAt <= nowAfter) {
            current.nextAt = nowAfter + current.intervalMs;
        }

        scheduleContinuous(context);
    }, delay);
}

self.onmessage = function(e) {
    const { type, payload } = e.data || {};
    const context = payload?.context;

    if (!context) return;

    if (type === "armIdle") {
        const delayMs = Number(payload.delayMs);
        const token = payload.token;
        const delay = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 0;

        if (idleTimers[context]) {
            clearTimeout(idleTimers[context]);
        }

        idleTimers[context] = setTimeout(() => {
            delete idleTimers[context];
            self.postMessage({
                type: "idle",
                payload: { context, token }
            });
        }, delay);
        return;
    }

    if (type === "clearIdle") {
        if (idleTimers[context]) {
            clearTimeout(idleTimers[context]);
            delete idleTimers[context];
        }
        return;
    }

    if (type === "startContinuous") {
        const intervalMs = Number(payload.intervalMs);
        const token = payload.token;
        const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 1;

        clearContinuous(context);
        continuousTimers[context] = {
            intervalMs: interval,
            token,
            nextAt: Date.now(),
            timer: null
        };
        scheduleContinuous(context);
        return;
    }

    if (type === "stopContinuous") {
        clearContinuous(context);
    }
};
