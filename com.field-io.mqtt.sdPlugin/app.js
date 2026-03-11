const MqttManager = {
    clients: {},
    connecting: {},
    connectingSince: {},
    queue: {},
    autoClientIds: {},
    continuousState: {},
    continuousSeq: {},

    getContextId(context) {
        if (typeof context === "string") return context;
        return context?.context || context;
    },

    getConfigKey(settings) {
        const clientIdPart = settings.valClientId && settings.valClientId.trim() !== ""
            ? settings.valClientId.trim()
            : "__auto__";
        return `${settings.valBroker}|${settings.valPort}|${settings.valUsername}|${settings.valSsl}|${clientIdPart}`;
    },

    normalizeSettings(settings) {
        const normalized = Object.assign({}, settings || {});
        if (normalized.valClientId && normalized.valClientId.trim() !== "") {
            normalized.valClientId = normalized.valClientId.trim();
            return normalized;
        }

        const key = this.getConfigKey(normalized);
        if (!this.autoClientIds[key]) {
            this.autoClientIds[key] = "sd_" + makeId(8);
        }
        normalized.valClientId = this.autoClientIds[key];
        return normalized;
    },

    getOrCreateClient(settings, onReady, onError, options) {
        const opts = options || {};
        if (!settings?.valBroker || !settings?.valPort) {
            if (typeof onError === "function") onError(new Error("MQTT broker and port are required"));
            return;
        }

        const normalizedSettings = this.normalizeSettings(settings);
        const key = this.getConfigKey(normalizedSettings);
        const client = this.clients[key];

        if (client && client.isConnected()) {
            onReady(client, normalizedSettings);
            return;
        }

        if (!this.queue[key]) this.queue[key] = [];
        const queueEntry = {
            onReady,
            onError,
            coalesceKey: opts.coalesceKey || null
        };
        if (queueEntry.coalesceKey) {
            const existingIndex = this.queue[key].findIndex((entry) => entry.coalesceKey === queueEntry.coalesceKey);
            if (existingIndex >= 0) {
                this.queue[key][existingIndex] = queueEntry;
            } else {
                this.queue[key].push(queueEntry);
            }
        } else {
            this.queue[key].push(queueEntry);
        }

        if (this.connecting[key]) return;

        this.connecting[key] = true;
        this.connectingSince[key] = Date.now();

        try {
            const newClient = new Paho.MQTT.Client(
                normalizedSettings.valBroker,
                Number(normalizedSettings.valPort),
                normalizedSettings.valClientId
            );

            let settled = false;
            const settleSuccess = () => {
                if (settled) return false;
                settled = true;
                return true;
            };
            const settleFailure = (err) => {
                if (settled) return false;
                settled = true;
                this.connecting[key] = false;
                delete this.connectingSince[key];
                delete this.clients[key];

                const pending = this.queue[key] || [];
                delete this.queue[key];
                pending.forEach((entry) => {
                    if (typeof entry.onError === "function") {
                        entry.onError(err);
                    }
                });
                return true;
            };
            const watchdog = setTimeout(() => {
                settleFailure(new Error("MQTT connect watchdog timeout"));
                try { newClient.disconnect(); } catch (e) {}
            }, 12000);

            newClient.onConnectionLost = (responseObject) => {
                console.warn("MQTT connection lost:", responseObject?.errorMessage || "");
                delete this.clients[key];
                delete this.connecting[key];
                delete this.connectingSince[key];
            };

            newClient.connect({
                timeout: 5,
                keepAliveInterval: 30,
                useSSL: normalizedSettings.valSsl === "true",
                userName: normalizedSettings.valUsername || "",
                password: normalizedSettings.valPassword || "",
                onSuccess: () => {
                    if (!settleSuccess()) return;
                    clearTimeout(watchdog);
                    this.connecting[key] = false;
                    delete this.connectingSince[key];
                    this.clients[key] = newClient;

                    const pending = this.queue[key] || [];
                    delete this.queue[key];
                    pending.forEach((entry) => {
                        try {
                            if (typeof entry.onReady === "function") {
                                entry.onReady(newClient, normalizedSettings);
                            }
                        } catch (err) {
                            console.error("Queued MQTT callback failed:", err);
                        }
                    });
                },
                onFailure: (err) => {
                    clearTimeout(watchdog);
                    settleFailure(err);
                }
            });
        } catch (err) {
            this.connecting[key] = false;
            delete this.connectingSince[key];
            delete this.clients[key];
            const pending = this.queue[key] || [];
            delete this.queue[key];
            pending.forEach((entry) => {
                if (typeof entry.onError === "function") {
                    entry.onError(err);
                }
            });
        }
    },

    send(context, settings, topic, msg, retain, onSent, onError, options) {
        const ctx = this.getContextId(context);
        this.getOrCreateClient(
            settings,
            (client, normalizedSettings) => {
                try {
                    const message = new Paho.MQTT.Message(String(msg ?? ""));
                    message.destinationName = topic || "";
                    message.retained = retain === "true";
                    client.send(message);
                    if (typeof onSent === "function") onSent(normalizedSettings);
                } catch (err) {
                    if (ctx) $SD.api.showAlert(ctx);
                    console.error("MQTT send error:", err);
                    if (typeof onError === "function") onError(err);
                }
            },
            (err) => {
                if (ctx) $SD.api.showAlert(ctx);
                console.error("MQTT connection failed:", err);
                if (typeof onError === "function") onError(err);
            },
            options
        );
    },

    onContinuousTick(ctx, token) {
        const context = this.getContextId(ctx);
        if (!context) return;

        const state = this.continuousState[context];
        if (!state) return;
        if (token !== undefined && token !== null && state.token !== token) return;

        const currentValue = Number.isFinite(state.currentValue) ? state.currentValue : Number(state.currentValue) || 0;
        const lastSentValue = Number.isFinite(state.lastSentValue) ? state.lastSentValue : Number(state.lastSentValue) || 0;
        const delta = computeDialDelta(currentValue, lastSentValue, state.settings);
        const messageText = renderDialMessage(state.settings.valMessage, currentValue, delta);

        this.send(
            context,
            state.settings,
            state.settings.valTopic,
            messageText,
            state.settings.valRetain,
            null,
            null,
            { coalesceKey: `continuous:${context}` }
        );
        state.lastSentValue = currentValue;
    },

    startContinuous(ctx, settings, intervalMs, initialValue) {
        const context = this.getContextId(ctx);
        if (!context) return;

        this.stopContinuous(context);

        const normalizedSettings = this.normalizeSettings(settings || {});
        const startValue = Number.isFinite(initialValue) ? initialValue : Number(initialValue) || 0;
        const safeIntervalMs = Number(intervalMs);
        const delay = Number.isFinite(safeIntervalMs) && safeIntervalMs > 0 ? safeIntervalMs : 1000;
        const token = (this.continuousSeq[context] || 0) + 1;
        this.continuousSeq[context] = token;

        this.continuousState[context] = {
            settings: normalizedSettings,
            currentValue: startValue,
            lastSentValue: startValue,
            intervalMs: delay,
            token
        };

        TimerBridge.startContinuous(context, delay, token);
        this.onContinuousTick(context, token);
    },

    stopContinuous(ctx) {
        const context = this.getContextId(ctx);
        if (!context) return;

        TimerBridge.stopContinuous(context);
        delete this.continuousState[context];
        delete this.continuousSeq[context];
    },

    updateValue(ctx, value) {
        const context = this.getContextId(ctx);
        if (!context) return;
        if (this.continuousState[context]) {
            this.continuousState[context].currentValue = value;
        }
    }
};

function sendMqtt(jsonObj, broker, port, username, password, ssl, clientid, topic, msg, retain) {
    const settings = {
        valBroker: broker,
        valPort: port,
        valUsername: username,
        valPassword: password,
        valSsl: ssl,
        valClientId: clientid
    };

    MqttManager.send(jsonObj, settings, topic, msg, retain, () => {
        $SD.api.showOk(jsonObj);
    });
}

$SD.on("connected", (jsonObj) => connected(jsonObj));

function connected(jsonObj) {
    $SD.on("com.field-io.mqtt.action.willAppear", (jsonObj) => action.onWillAppear(jsonObj));
    $SD.on("com.field-io.mqtt.action.keyDown", (jsonObj) => action.onKeyDown(jsonObj));
    $SD.on("com.field-io.mqtt.action.didReceiveSettings", (jsonObj) => action.onDidReceiveSettings(jsonObj));
    $SD.on("com.field-io.mqtt.action.sendToPlugin", (jsonObj) => action.onSendToPlugin(jsonObj));

    // Dial
    $SD.on("com.field-io.mqtt.dial.willAppear", (jsonObj) => dialAction.onWillAppear(jsonObj));
    $SD.on("com.field-io.mqtt.dial.didReceiveSettings", (jsonObj) => dialAction.onDidReceiveSettings(jsonObj));
    $SD.on("com.field-io.mqtt.dial.sendToPlugin", (jsonObj) => dialAction.onSendToPlugin(jsonObj));
    $SD.on("com.field-io.mqtt.dial.dialRotate", (jsonObj) => dialAction.onDialRotate(jsonObj));
    $SD.on("com.field-io.mqtt.dial.dialDown", (jsonObj) => dialAction.onDialDown(jsonObj));
    $SD.on("com.field-io.mqtt.dial.willDisappear", (jsonObj) => dialAction.onWillDisappear(jsonObj));
}

function makeId(len) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function getUtcTimestampIso() {
    return new Date().toISOString();
}

function renderDialMessage(template, value, delta) {
    const timestampUtc = getUtcTimestampIso();
    let msg = template || "";
    msg = msg.replace(/\{\{\s*value\s*\}\}/g, String(value));
    msg = msg.replace(/\{\{\s*delta\s*\}\}/g, String(delta));
    // UTC timestamp aliases: {{timestamp_utc}}, {{timestampUtc}}, {{timestamp}}
    msg = msg.replace(/\{\{\s*timestamp_utc\s*\}\}/gi, timestampUtc);
    msg = msg.replace(/\{\{\s*timestampUtc\s*\}\}/gi, timestampUtc);
    msg = msg.replace(/\{\{\s*timestamp\s*\}\}/gi, timestampUtc);
    return msg;
}

function computeDialDelta(currentValue, previousValue, settings) {
    const current = Number.isFinite(currentValue) ? currentValue : Number(currentValue) || 0;
    const previous = Number.isFinite(previousValue) ? previousValue : Number(previousValue) || 0;

    let delta = current - previous;

    const wrap = settings?.wrap === "true";
    let min = Number(settings?.min);
    let max = Number(settings?.max);
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 100;

    if (!wrap || !(max > min)) {
        return delta;
    }

    const span = max - min + 1;
    if (span <= 0) {
        return delta;
    }

    if (delta > span / 2) {
        delta -= span;
    } else if (delta < -span / 2) {
        delta += span;
    }

    return delta;
}

const action = {
    onDidReceiveSettings(jsonObj) {
        console.log("[onDidReceiveSettings]", jsonObj);
    },

    onWillAppear(jsonObj) {
        const settings = Utils.getProp(jsonObj, "payload.settings", {});
        $SD.api.sendToPropertyInspector(jsonObj.context, settings, jsonObj.action);
    },

    onSendToPlugin(jsonObj) {
        if (jsonObj.payload) {
            $SD.api.setSettings(jsonObj.context, jsonObj.payload);
        }
    },

    onKeyDown(jsonObj) {
        const s = jsonObj.payload.settings;
        sendMqtt(
            jsonObj.context,
            s.valBroker,
            s.valPort,
            s.valUsername,
            s.valPassword,
            s.valSsl,
            s.valClientId,
            s.valTopic,
            s.valMessage,
            s.valRetain
        );
    }
};

// -------------------------------------------------------------------
// -------------------------- DIAL SUPPORT ---------------------------
// -------------------------------------------------------------------

const dialState = {};
const dialPreviousValue = {};
const dialContinuousSettings = {};
const dialLastSettingsSyncAt = {};
const dialLastFeedbackUpdateAt = {};
const dialIdleSendSeq = {};
const dialControllerByContext = {};
const dialSlotByContext = {};
const dialPrimaryContextBySlot = {};
// Trailing debounce for "dial stopped" in non-continuous mode.
// We cannot detect stop instantly; this short window avoids false stop events while still feeling immediate.
const NON_CONTINUOUS_IDLE_SEND_MS = 60;
const continuousConfigKeys = [
    "continuousSend",
    "continuousHz",
    "valBroker",
    "valPort",
    "valUsername",
    "valPassword",
    "valSsl",
    "valClientId",
    "valTopic",
    "valMessage",
    "valRetain"
];

const TimerBridge = {
    worker: undefined,
    fallbackIdleTimers: {},
    fallbackContinuousTimers: {},
    onIdle: null,
    onContinuousTick: null,

    ensure() {
        if (this.worker !== undefined) return;
        try {
            this.worker = new Worker("timingWorker.js");
            this.worker.onmessage = (e) => {
                const { type, payload } = e.data || {};
                if (type === "idle" && typeof this.onIdle === "function") {
                    this.onIdle(payload?.context, payload?.token);
                } else if (type === "continuousTick" && typeof this.onContinuousTick === "function") {
                    this.onContinuousTick(payload?.context, payload?.token);
                }
            };
        } catch (err) {
            // Fallback when worker is unavailable in the host runtime.
            this.worker = null;
            console.warn("Timer worker unavailable; using main-thread timers.", err);
        }
    },

    armIdle(context, delayMs, token) {
        this.ensure();
        if (this.worker) {
            this.worker.postMessage({
                type: "armIdle",
                payload: { context, delayMs, token }
            });
            return;
        }

        if (this.fallbackIdleTimers[context]) {
            clearTimeout(this.fallbackIdleTimers[context]);
        }
        this.fallbackIdleTimers[context] = setTimeout(() => {
            delete this.fallbackIdleTimers[context];
            if (typeof this.onIdle === "function") {
                this.onIdle(context, token);
            }
        }, delayMs);
    },

    clearIdle(context) {
        this.ensure();
        if (this.worker) {
            this.worker.postMessage({
                type: "clearIdle",
                payload: { context }
            });
        }

        if (this.fallbackIdleTimers[context]) {
            clearTimeout(this.fallbackIdleTimers[context]);
            delete this.fallbackIdleTimers[context];
        }
    },

    startContinuous(context, intervalMs, token) {
        this.ensure();
        if (this.worker) {
            this.worker.postMessage({
                type: "startContinuous",
                payload: { context, intervalMs, token }
            });
            return;
        }

        if (this.fallbackContinuousTimers[context]) {
            clearInterval(this.fallbackContinuousTimers[context]);
        }
        const delay = Math.max(1, Number(intervalMs) || 1);
        this.fallbackContinuousTimers[context] = setInterval(() => {
            if (typeof this.onContinuousTick === "function") {
                this.onContinuousTick(context, token);
            }
        }, delay);
    },

    stopContinuous(context) {
        this.ensure();
        if (this.worker) {
            this.worker.postMessage({
                type: "stopContinuous",
                payload: { context }
            });
        }

        if (this.fallbackContinuousTimers[context]) {
            clearInterval(this.fallbackContinuousTimers[context]);
            delete this.fallbackContinuousTimers[context];
        }
    }
};

function sendDialMqtt(jsonObj, settings, value, delta, onSent) {
    const msg = renderDialMessage(settings.valMessage, value, delta);

    MqttManager.send(jsonObj, settings, settings.valTopic, msg, settings.valRetain, onSent);
}

function updateDialFeedback(ctx, value, settings, force) {
    const now = Date.now();
    const last = dialLastFeedbackUpdateAt[ctx] || 0;

    // Throttle feedback updates to max 30Hz (approx 33ms) unless forced
    if (!force && now - last < 33) return;
    dialLastFeedbackUpdateAt[ctx] = now;

    let min = Number(settings.min);
    let max = Number(settings.max);
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 100;

    let progress = 0;
    if (max !== min) {
        progress = ((value - min) * 100) / (max - min);
    }
    progress = Math.max(0, Math.min(100, progress));

    const valueText = String(value);

    $SD.api.send(ctx, "setFeedback", {
        payload: {
            value: valueText,
            indicator: { value: progress }
        }
    });
}

function mergeDialSettings(ctx, incoming) {
    return Object.assign({}, dialContinuousSettings[ctx] || {}, incoming || {});
}

function clearIdleSendTimer(ctx) {
    dialIdleSendSeq[ctx] = (dialIdleSendSeq[ctx] || 0) + 1;
    TimerBridge.clearIdle(ctx);
}

function scheduleIdleDeltaZeroSend(ctx) {
    clearIdleSendTimer(ctx);

    const initialSettings = dialContinuousSettings[ctx];
    if (!initialSettings || initialSettings.continuousSend === "true") {
        return;
    }

    const token = (dialIdleSendSeq[ctx] || 0) + 1;
    dialIdleSendSeq[ctx] = token;

    TimerBridge.armIdle(ctx, NON_CONTINUOUS_IDLE_SEND_MS, token);
}

TimerBridge.onIdle = (ctx, token) => {
    if (dialIdleSendSeq[ctx] !== token) {
        return;
    }
    delete dialIdleSendSeq[ctx];

    if (!ctx) {
        return;
    }

    try {
        const latestSettings = dialContinuousSettings[ctx];
        if (!latestSettings || latestSettings.continuousSend === "true") {
            return;
        }

        const value = Number.isFinite(dialState[ctx]) ? dialState[ctx] : Number(latestSettings.value) || 0;
        sendDialMqtt(ctx, latestSettings, value, 0);
    } catch (err) {
        console.error("Idle delta=0 send failed:", err);
    }
};

TimerBridge.onContinuousTick = (ctx, token) => {
    try {
        MqttManager.onContinuousTick(ctx, token);
    } catch (err) {
        console.error("Continuous tick send failed:", err);
    }
};

function getDialSlotKey(jsonObj) {
    const device = jsonObj?.device;
    const row = jsonObj?.payload?.coordinates?.row;
    const column = jsonObj?.payload?.coordinates?.column;
    if (device === undefined || row === undefined || column === undefined) {
        return null;
    }
    return `${device}:${row}:${column}`;
}

function isEncoderContext(ctx, jsonObj) {
    const controller = jsonObj?.payload?.controller;
    if (typeof controller === "string" && controller.length > 0) {
        dialControllerByContext[ctx] = controller;
        if (controller !== "Encoder") {
            return false;
        }

        const slotKey = getDialSlotKey(jsonObj);
        if (!slotKey) {
            return true;
        }

        dialSlotByContext[ctx] = slotKey;
        const primaryCtx = dialPrimaryContextBySlot[slotKey];
        if (!primaryCtx || primaryCtx === ctx) {
            dialPrimaryContextBySlot[slotKey] = ctx;
            return true;
        }

        const primaryStillActive =
            !!dialContinuousSettings[primaryCtx] ||
            !!dialControllerByContext[primaryCtx] ||
            !!MqttManager.continuousState[primaryCtx];
        if (!primaryStillActive) {
            dialPrimaryContextBySlot[slotKey] = ctx;
            return true;
        }

        return false;
    }

    const knownController = dialControllerByContext[ctx];
    if (typeof knownController === "string" && knownController.length > 0) {
        return knownController === "Encoder";
    }

    // Per SDK, dial events include `controller: "Encoder"`; treat unknown as non-encoder.
    return false;
}

function didContinuousConfigChange(previousSettings, currentSettings) {
    return continuousConfigKeys.some((key) => {
        const previousValue = previousSettings?.[key] ?? "";
        const currentValue = currentSettings?.[key] ?? "";
        return previousValue !== currentValue;
    });
}

function syncDialSettings(ctx, settings, force) {
    const now = Date.now();
    const last = Number.isFinite(dialLastSettingsSyncAt[ctx]) ? dialLastSettingsSyncAt[ctx] : 0;
    // Debounce/Throttle settings sync to max 1Hz (1000ms) unless forced.
    // settings sync is expensive as it writes to disk.
    if (!force && now - last < 1000) return;
    $SD.api.setSettings(ctx, settings);
    dialLastSettingsSyncAt[ctx] = now;
}

function stopContinuousSend(ctx) {
    MqttManager.stopContinuous(ctx);
}

function getContinuousIntervalMs(settings) {
    let hz = Number(settings.continuousHz);
    if (!Number.isFinite(hz) || hz <= 0) hz = 1;
    // Cap at 400Hz
    if (hz > 400) hz = 400; 
    return 1000 / hz;
}

function startContinuousSend(ctx) {
    const s = dialContinuousSettings[ctx];
    if (!s) return;

    const enabled = s.continuousSend === "true";
    if (!enabled) {
        MqttManager.stopContinuous(ctx);
        return;
    }
    clearIdleSendTimer(ctx);

    const intervalMs = getContinuousIntervalMs(s);
    const initialValue = Number.isFinite(dialState[ctx]) ? dialState[ctx] : 0;

    MqttManager.startContinuous(ctx, s, intervalMs, initialValue);
}

const dialAction = {
    onDidReceiveSettings(jsonObj) {
        const ctx = jsonObj.context;
        if (!isEncoderContext(ctx, jsonObj)) {
            stopContinuousSend(ctx);
            clearIdleSendTimer(ctx);
            return;
        }
        const s = mergeDialSettings(ctx, jsonObj.payload.settings || {});
        const previousSettings = dialContinuousSettings[ctx] || {};
        const value = Number(s.value) || 0;

        dialState[ctx] = value;
        dialPreviousValue[ctx] = value;
        dialContinuousSettings[ctx] = Object.assign({}, s);
        updateDialFeedback(ctx, value, s);

        if (didContinuousConfigChange(previousSettings, s)) {
            startContinuousSend(ctx);
        } else if (s.continuousSend === "true") {
            clearIdleSendTimer(ctx);
            MqttManager.updateValue(ctx, value);
        }
    },

    onWillAppear(jsonObj) {
        const ctx = jsonObj.context;
        if (!isEncoderContext(ctx, jsonObj)) {
            stopContinuousSend(ctx);
            clearIdleSendTimer(ctx);
            return;
        }
        const s = mergeDialSettings(ctx, Utils.getProp(jsonObj, "payload.settings", {}) || {});
        const val = Number(s.value) || 0;

        dialState[ctx] = val;
        dialPreviousValue[ctx] = val;
        dialContinuousSettings[ctx] = Object.assign({}, s);

        $SD.api.sendToPropertyInspector(ctx, s, jsonObj.action);
        updateDialFeedback(ctx, val, s);

        startContinuousSend(ctx);
    },

    onWillDisappear(jsonObj) {
        const ctx = jsonObj.context;
        stopContinuousSend(ctx);
        clearIdleSendTimer(ctx);
        delete dialState[ctx];
        delete dialPreviousValue[ctx];
        delete dialContinuousSettings[ctx];
        delete dialLastSettingsSyncAt[ctx];
        delete dialLastFeedbackUpdateAt[ctx];
        delete dialControllerByContext[ctx];
        const slotKey = dialSlotByContext[ctx];
        if (slotKey && dialPrimaryContextBySlot[slotKey] === ctx) {
            delete dialPrimaryContextBySlot[slotKey];
        }
        delete dialSlotByContext[ctx];
    },

    onSendToPlugin(jsonObj) {
        if (jsonObj.payload) {
            const ctx = jsonObj.context;
            const merged = mergeDialSettings(ctx, jsonObj.payload);
            dialContinuousSettings[ctx] = Object.assign({}, merged);
            $SD.api.setSettings(ctx, merged);
            if (isEncoderContext(ctx, jsonObj)) {
                startContinuousSend(ctx);
            } else {
                clearIdleSendTimer(ctx);
            }
        }
    },

    onDialRotate(jsonObj) {
        const ctx = jsonObj.context;
        if (!isEncoderContext(ctx, jsonObj)) {
            return;
        }
        const s = mergeDialSettings(ctx, jsonObj.payload.settings || {});
        const ticks = jsonObj.payload.ticks || 0;

        let step = Number(s.stepSize);
        if (!Number.isFinite(step) || step === 0) step = 1;

        let value = dialState[ctx] ?? Number(s.value) ?? 0;

        let min = Number(s.min);
        let max = Number(s.max);
        if (!Number.isFinite(min)) min = 0;
        if (!Number.isFinite(max)) max = 100;

        const wrap = s.wrap === "true";
        const previousValue = value;

        let newValue = value + ticks * step;

        if (wrap && max > min) {
            const span = max - min + 1;
            let pos = (newValue - min) % span;
            if (pos < 0) pos += span;
            newValue = min + pos;
        } else {
            newValue = Math.max(min, Math.min(max, newValue));
        }

        const delta = computeDialDelta(newValue, previousValue, s);

        dialState[ctx] = newValue;
        dialPreviousValue[ctx] = newValue;

        const newSettings = Object.assign({}, s, { value: newValue });
        dialContinuousSettings[ctx] = Object.assign({}, newSettings);
        syncDialSettings(ctx, newSettings, false);

        updateDialFeedback(ctx, newValue, newSettings);
        if (newSettings.continuousSend === "true") {
            clearIdleSendTimer(ctx);
            MqttManager.updateValue(ctx, newValue);
        } else {
            sendDialMqtt(jsonObj, newSettings, newValue, delta);
            scheduleIdleDeltaZeroSend(ctx);
        }
    },

    onDialDown(jsonObj) {
        const ctx = jsonObj.context;
        if (!isEncoderContext(ctx, jsonObj)) {
            return;
        }
        const s = mergeDialSettings(ctx, jsonObj.payload.settings || {});

        let min = Number(s.min);
        if (!Number.isFinite(min)) min = 0;

        const previous = Number.isFinite(dialPreviousValue[ctx]) ? dialPreviousValue[ctx] : min;
        const delta = min - previous;

        dialState[ctx] = min;
        dialPreviousValue[ctx] = min;

        const newSettings = Object.assign({}, s, { value: min });
        dialContinuousSettings[ctx] = Object.assign({}, newSettings);
        syncDialSettings(ctx, newSettings, true);

        updateDialFeedback(ctx, min, newSettings);
        if (newSettings.continuousSend === "true") {
            clearIdleSendTimer(ctx);
            MqttManager.updateValue(ctx, min);
        } else {
            sendDialMqtt(jsonObj, newSettings, min, delta);
            scheduleIdleDeltaZeroSend(ctx);
        }
    }
};
