function sendMqtt(jsonObj, broker, port, username, password, ssl, clientid, topic, msg, retain) {
    if (clientid == "") {
        clientid = makeId(8);
    }

    const client = new Paho.MQTT.Client(broker, Number(port), clientid);
    client.connect({
        onSuccess: () => {
            const message = new Paho.MQTT.Message(msg);
            message.destinationName = topic;
            message.retained = retain === "true";

            client.send(message);
            $SD.api.showOk(jsonObj);
            client.disconnect();
        },
        onFailure: () => {
            $SD.api.showAlert(jsonObj);
        },
        timeout: 5,
        useSSL: ssl === "true",
        userName: username || "",
        password: password || ""
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
}

function makeId(len) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
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
let dialClient = null;
let dialClientConnected = false;
let dialClientConnecting = false;
let dialClientKey = "";
let dialQueue = [];

function dialConfigKey(s) {
    return `${s.valBroker}|${s.valPort}|${s.valUsername}|${s.valSsl}|${s.valClientId}`;
}

function ensureDialClient(settings, onReady) {
    const key = dialConfigKey(settings);

    if (dialClient && dialClientConnected && dialClientKey === key) {
        onReady();
        return;
    }

    if (dialClientConnecting && dialClientKey === key) {
        dialQueue.push(onReady);
        return;
    }

    dialClientKey = key;
    dialClientConnecting = true;

    let clientId = settings.valClientId || makeId(8);

    dialClient = new Paho.MQTT.Client(settings.valBroker, Number(settings.valPort), clientId);

    dialClient.onConnectionLost = () => {
        dialClientConnected = false;
        dialClientConnecting = false;
    };

    dialClient.connect({
        timeout: 5,
        useSSL: settings.valSsl === "true",
        userName: settings.valUsername || "",
        password: settings.valPassword || "",
        onSuccess: () => {
            dialClientConnected = true;
            dialClientConnecting = false;

            const pending = dialQueue;
            dialQueue = [];
            pending.forEach((fn) => fn());
        },
        onFailure: () => {
            dialClientConnected = false;
            dialClientConnecting = false;
            dialQueue = [];
        }
    });
}

function updateDialFeedback(ctx, value, settings) {
    let min = Number(settings.min);
    let max = Number(settings.max);
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 100;

    let progress = ((value - min) * 100) / (max - min);
    progress = Math.max(0, Math.min(100, progress));

    // LCD shows ONLY the number now
    const valueText = String(value);

    $SD.api.send(ctx, "setFeedback", {
        payload: {
            value: valueText,
            indicator: { value: progress }
        }
    });
}

function sendDialMqtt(jsonObj, settings, value) {
    let msg = settings.valMessage || "";
    msg = msg.replace(/\{\{\s*value\s*\}\}/g, String(value));

    ensureDialClient(settings, () => {
        if (!dialClientConnected) return;

        try {
            const message = new Paho.MQTT.Message(msg);
            message.destinationName = settings.valTopic;
            message.retained = settings.valRetain === "true";
            dialClient.send(message);
        } catch (e) {
            console.error("MQTT send error", e);
        }
    });
}

const dialAction = {
    onDidReceiveSettings(jsonObj) {
        const ctx = jsonObj.context;
        const s = jsonObj.payload.settings || {};
        dialState[ctx] = Number(s.value) || 0;
    },

    onWillAppear(jsonObj) {
        const ctx = jsonObj.context;
        const s = Utils.getProp(jsonObj, "payload.settings", {}) || {};
        const val = Number(s.value) || 0;

        dialState[ctx] = val;

        $SD.api.sendToPropertyInspector(ctx, s, jsonObj.action);

        updateDialFeedback(ctx, val, s);
    },

    onSendToPlugin(jsonObj) {
        if (jsonObj.payload) {
            $SD.api.setSettings(jsonObj.context, jsonObj.payload);
        }
    },

    onDialRotate(jsonObj) {
        const ctx = jsonObj.context;
        const s = jsonObj.payload.settings || {};
        const ticks = jsonObj.payload.ticks || 0;

        let step = Number(s.stepSize);
        if (!Number.isFinite(step) || step === 0) step = 1;

        let value = dialState[ctx] ?? Number(s.value) ?? 0;

        let min = Number(s.min);
        let max = Number(s.max);
        if (!Number.isFinite(min)) min = 0;
        if (!Number.isFinite(max)) max = 100;

        const wrap = s.wrap === "true";

        let newValue = value + ticks * step;

        if (wrap && max > min) {
            const span = max - min + 1;
            let pos = (newValue - min) % span;
            if (pos < 0) pos += span;
            newValue = min + pos;
        } else {
            newValue = Math.max(min, Math.min(max, newValue));
        }

        dialState[ctx] = newValue;

        const newSettings = Object.assign({}, s, { value: newValue });
        $SD.api.setSettings(ctx, newSettings);

        updateDialFeedback(ctx, newValue, newSettings);

        sendDialMqtt(jsonObj, newSettings, newValue);
    },

    onDialDown(jsonObj) {
        const ctx = jsonObj.context;
        const s = jsonObj.payload.settings || {};

        let min = Number(s.min);
        if (!Number.isFinite(min)) min = 0;

        dialState[ctx] = min;

        const newSettings = Object.assign({}, s, { value: min });
        $SD.api.setSettings(ctx, newSettings);

        updateDialFeedback(ctx, min, newSettings);

        sendDialMqtt(jsonObj, newSettings, min);
    }
};
