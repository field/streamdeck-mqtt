let clients = {};
let connecting = {};
let queue = {};
let continuousIntervals = {};

self.onmessage = function(e) {
    const { type, payload } = e.data;

    switch (type) {
        case 'init':
            if (payload.pahoUrl) {
                try {
                    importScripts(payload.pahoUrl);
                } catch (err) {
                    console.error("Worker failed to import Paho:", err);
                }
            }
            break;
        case 'send':
            sendMqtt(payload);
            break;
        case 'startContinuous':
            startContinuous(payload);
            break;
        case 'stopContinuous':
            stopContinuous(payload);
            break;
        case 'updateValue':
            updateValue(payload);
            break;
    }
};

function getConfigKey(settings) {
    return `${settings.valBroker}|${settings.valPort}|${settings.valUsername}|${settings.valSsl}|${settings.valClientId}`;
}

function sendMqtt(data) {
    const { settings, topic, msg, retain, context } = data;
    getOrCreateClient(settings, (client) => {
        try {
            const message = new Paho.MQTT.Message(msg);
            message.destinationName = topic;
            message.retained = retain === "true";
            client.send(message);
            self.postMessage({ type: 'sent', payload: { context } });
        } catch (e) {
            console.error("Worker MQTT send error", e);
            self.postMessage({ type: 'error', payload: { context, error: e.message } });
        }
    }, context);
}

const continuousState = {};

function startContinuous(payload) {
    const { context, settings, intervalMs, initialValue } = payload;
    stopContinuous({ context });

    continuousState[context] = {
        settings,
        currentValue: initialValue,
        lastSentValue: initialValue
    };

    const runTick = () => {
        const state = continuousState[context];
        if (!state) return;

        const { settings, currentValue, lastSentValue } = state;
        const delta = currentValue - lastSentValue;

        let msg = settings.valMessage || "";
        msg = msg.replace(/\{\{\s*value\s*\}\}/g, String(currentValue));
        msg = msg.replace(/\{\{\s*delta\s*\}\}/g, String(delta));

        sendMqtt({
            settings,
            topic: settings.valTopic,
            msg,
            retain: settings.valRetain,
            context: context
        });

        state.lastSentValue = currentValue;
        
        // Schedule next tick
        if (continuousIntervals[context]) {
            continuousIntervals[context] = setTimeout(runTick, intervalMs);
        }
    };

    // Use setTimeout for better timing precision than setInterval in some environments
    continuousIntervals[context] = setTimeout(runTick, intervalMs);
}

function stopContinuous(payload) {
    const { context } = payload;
    if (continuousIntervals[context]) {
        clearTimeout(continuousIntervals[context]);
        delete continuousIntervals[context];
    }
    delete continuousState[context];
}

function updateValue(payload) {
    const { context, value } = payload;
    if (continuousState[context]) {
        continuousState[context].currentValue = value;
    }
}

function getOrCreateClient(settings, onReady, context) {
    const key = getConfigKey(settings);
    const client = clients[key];

    if (client && client.isConnected()) {
        onReady(client);
        return;
    }

    if (connecting[key]) {
        if (!queue[key]) queue[key] = [];
        queue[key].push(onReady);
        return;
    }

    connecting[key] = true;
    const clientId = settings.valClientId || ("worker_" + Math.random().toString(36).substring(2, 10));
    
    if (typeof Paho === 'undefined') {
        console.error("Paho not loaded in worker");
        connecting[key] = false;
        const pending = queue[key] || [];
        delete queue[key];
        self.postMessage({ type: 'error', payload: { context, error: "Paho library not loaded" } });
        return;
    }

    try {
        const newClient = new Paho.MQTT.Client(settings.valBroker, Number(settings.valPort), clientId);

        newClient.onConnectionLost = (responseObject) => {
            console.log("Worker MQTT connection lost:", responseObject.errorMessage);
            delete clients[key];
            delete connecting[key];
            self.postMessage({ type: 'connectionLost', payload: { context, key, error: responseObject.errorMessage } });
        };

        newClient.onMessageArrived = (message) => {
            // Optional: handle incoming messages if needed
        };

        const connectOptions = {
            timeout: 5,
            keepAliveInterval: 30,
            useSSL: settings.valSsl === "true",
            userName: settings.valUsername || "",
            password: settings.valPassword || "",
            onSuccess: () => {
                connecting[key] = false;
                clients[key] = newClient;
                const pending = queue[key] || [];
                delete queue[key];
                pending.forEach((fn) => {
                    try { fn(newClient); } catch(e) { console.error("Error in queued onReady", e); }
                });
                onReady(newClient);
                self.postMessage({ type: 'connected', payload: { context, key } });
            },
            onFailure: (err) => {
                console.error("Worker MQTT connection failed:", err);
                connecting[key] = false;
                const pending = queue[key] || [];
                delete queue[key];
                // Notify failures to all pending
                self.postMessage({ type: 'connectionFailed', payload: { context, key, error: err.errorMessage || JSON.stringify(err) } });
            }
        };

        newClient.connect(connectOptions);
    } catch (e) {
        console.error("Error creating Paho client:", e);
        connecting[key] = false;
        delete queue[key];
        self.postMessage({ type: 'error', payload: { context, error: e.message } });
    }
}
