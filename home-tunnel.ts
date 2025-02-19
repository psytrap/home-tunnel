import { join } from "jsr:@std/path";
//import { parseArgs } from "jsr:@std/cli/parse-args";
import { sleep } from "https://deno.land/x/sleep/mod.ts"
import { Command } from "jsr:@cliffy/command@^1.0.0-rc.7"
import { Input, Number, Toggle } from "jsr:@cliffy/prompt@^1.0.0-rc.7"
import { bold, red } from "jsr:@std/fmt/colors";
import { ensureDirSync } from "jsr:@std/fs/ensure-dir";


// TODO backplane comms - global reset
// TODO API key based security
// TODO only one connection at time better
// TODO error handling / failure points analysis
// TODO Timeout for inital connection setup
// TODO version numbering
// TODO use command and response enum
// TODO shutdown relay with password
// TODO graceful shutdown
// TODO idle restart option / timeout

const LOCALHOST = "127.0.0.1";
const RETRY_TIME = 2 * 60;
const CONNECTION_RESET_TIME = 3600; // 1 hour
const cmd = new Command()
    .name("Home Tunnel")
    .version("0.0.5") // Don't forget release tags
    .description("Home Tunnel CLI for the local and the remote node")
    .option("-p, --port <port:number>", "Port number (destination/source)")
    .option("-x, --relay <relay:string>", "URL of relay")
    .option("-i, --host <host:string>", "Hostname or IP to be forwarded", { default: LOCALHOST })
    .option("-r, --remote", "Use as remote connection client")
    .option("-t, --tui", "Terminal based UI");
const { options } = await cmd.parse(Deno.args);


let REMOTE: boolean | undefined;
let SIDE: string | undefined;
let URL: string;
let PORT: number;
let IP_ADDR: string | undefined;
// let API_KEY

console.log(options);
console.log(options.port);

async function loadConfig(configFile: string): Promise<any | null> {
    try {
        const configText = await Deno.readTextFile(configFile);
        const config = JSON.parse(configText);
        return config;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return {};
        } else if (error instanceof SyntaxError) {
            return {};
        } else {
            throw error;
        }
    }
}
if (options.tui === true) {
    const config_dir = join(getConfigDirectory(true), "home-tunnel");
    const config_filename = join(config_dir, "home-tunnel.json");
    ensureDirSync(config_dir);
    let config = await loadConfig(config_filename);
    if (Object.keys(config).length !== 0) {
        console.log("Config file found: " + config_filename)
    }
    config.port = options.port ?? config.port; // initially undefined
    config.relay = options.relay ?? config.relay; // initially undefined
    config.remote = options.remote ?? config.remote; // initially undefined
    if (options.host !== LOCALHOST) {
        config.host = options.host;
    }
    console.log(config);
    config.port = await Number.prompt({
        message: "Enter the port number to be used:",
        default: config.port,
    });
    //console.log(globalThis.URL.parse("wss://simple-socket-relay.deno.dev"));
    config.relay = await Input.prompt({
        message: 'Enter the URL of the relay server:',
        default: config.relay,
        validate: (value) => {
            try {
                globalThis.URL.parse(value);
                return true;
            } catch (error) {
                return 'Invalid URL. Please enter a valid URL (e.g., https://www.example.com).';
            }
        },
    });
    // cliffy doesn't validated default :(
    config.remote = await Toggle.prompt({
        message: "Run as the remote client:",
        default: config.remote,
    });
    if (config.remote !== true) {
        config.host = await Input.prompt({
            message: "Enter IP or hostname to be forwarded:",
            default: config.host,
        });
    }
    // Safe config
    const jsonString = JSON.stringify(config, null, 4);
    await Deno.writeTextFile(config_filename, jsonString);
    REMOTE = config.remote;
    SIDE = REMOTE ? "left" : "right";
    URL = config.relay + '/' + SIDE;
    PORT = config.port;
    IP_ADDR = config.host;
} else {
    if (options.port === undefined || options.relay === undefined) {
        cmd.showHelp();
        console.log(red((bold("  Error: Missing required option \"--tui\" OR required option \"--port\" and \"--relay\""))));
        Deno.exit(0);
    }
    REMOTE = options.remote ?? false;
    SIDE = REMOTE ? "left" : "right";
    URL = options.relay + '/' + SIDE;
    PORT = options.port;
    IP_ADDR = options.host;
}

try {
    const url = new globalThis.URL(URL);
    if (!(url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:")) {
        throw -1;
    }
} catch (error) {
    throw 'Invalid URL. Please enter a valid URL (e.g., https://www.example.com or wss://exampel.com/ws).';
}



enum States {
    ERROR = "error", // any_error
    INIT = "init", // from error
    READY = "ready", // init done or ack_closed
    OPENING = "opening", // open cmd
    OPEN = "open", // port opened
    CLOSING = "closing", // close cmd or port closed
    CLOSED = "closed", // buffer and port closed
}

enum Commands {
    RESET = 'reset',
    OPEN = 'open',
    CLOSE = 'close',
    ACK_CLOSED = 'ack_closed',
    SYNC = 'sync'
}
function enumFromStringValue<T>(enm: { [s: string]: T }, value: string): T | undefined {
    return (Object.values(enm) as unknown as string[]).includes(value)
        ? value as unknown as T
        : undefined;
}

function stringToState(state: string): States | undefined {
    return enumFromStringValue(States, state);
}


const webSocketState: { [key: number]: string } = {
    [WebSocket.CONNECTING]: "CONNECTING",
    [WebSocket.OPEN]: "OPEN",
    [WebSocket.CLOSING]: "CLOSING",
    [WebSocket.CLOSED]: "CLOSED",
};

interface ProcessingFunction<T> {
    (event: T): Promise<void>;
}

interface EventFunction<T> {
    (blob: T): Promise<void>;
}

class QueueProcessor<T> {
    private processing: boolean = false;
    private dataQueue: T[] = [];
    private processFunction: ProcessingFunction<T>;

    constructor(processFunc: ProcessingFunction<T>) {
        this.processFunction = processFunc;
    }

    public addData(data: T): boolean {
        this.dataQueue.push(data);
        this.processData();
        return this.processing;
    }
    /*
        public async processDelayed() {
            // set timeout
        }
    */
    private async processData(): Promise<void> {
        if (this.processing || this.dataQueue.length === 0) {
            return; // Exit if already processing or no messages
        }

        this.processing = true;

        while (this.dataQueue.length > 0) {
            const data = this.dataQueue.shift(); // Get the next message

            if (data !== undefined) {
                try {
                    await this.processFunction(data);
                } catch (error) {
                    console.error("Error processing message:", error);
                }
            }
        }

        this.processing = false;
    }
}

function getConfigDirectory(roaming: boolean): string {
    if (Deno.build.os === "linux") {
        const config_dir = Deno.env.get("XDG_CONFIG_HOME");
        if (config_dir) {
            return config_dir;
        } else {
            return "~/.config";
        }
    } else if (Deno.build.os === "windows") {
        const config_dir = roaming
            ? Deno.env.get("APPDATA") // Roaming AppData
            : Deno.env.get("LOCALAPPDATA"); // Local AppData
        if (config_dir === undefined) {
            throw new Error("Config dir cannot be resolved. (%APPDATA% / %LOCALAPPDATA%)");
        }
        return config_dir;
    } else if (Deno.build.os === "darwin") {
        return "~/Library/Preferences";
    } else {
        throw new Error("Unknown operating system");
    }
}

function encodeStringWithLength(header: object, payload: ArrayBuffer): ArrayBuffer {
    const headerString = JSON.stringify(header);
    const length = headerString.length;
    const lengthString = length.toString().padStart(4, "0");
    // Convert the input string and length string to Uint8Arrays
    const stringEncoder = new TextEncoder();
    const lengthBytes = stringEncoder.encode(lengthString);
    const stringBytes = stringEncoder.encode(headerString);
    // Calculate the total length of the output ArrayBuffer
    const totalLength = lengthBytes.length + stringBytes.length + payload.byteLength;
    // Create the output ArrayBuffer
    const outputBuffer = new ArrayBuffer(totalLength);
    const outputView = new Uint8Array(outputBuffer);
    // Copy the length, string, and payload into the output ArrayBuffer
    outputView.set(lengthBytes, 0);
    outputView.set(stringBytes, lengthBytes.length);
    outputView.set(new Uint8Array(payload), lengthBytes.length + stringBytes.length);

    return outputBuffer;
}

function decodeStringWithLength(buffer: ArrayBuffer): { header: object; payload: ArrayBuffer } {
    const view = new Uint8Array(buffer);
    const lengthString = new TextDecoder().decode(view.subarray(0, 4));
    const length = parseInt(lengthString, 10);
    const header = JSON.parse(new TextDecoder().decode(view.subarray(4, 4 + length)));
    const payload = buffer.slice(4 + length);

    return { header, payload };
}

function addEventListeners(socket: WebSocket) { // , messageFunc: EventFunction<MessageEvent>
    socket.addEventListener("error", (event) => {
        console.error("WebSocket error:", event);
    });
}

async function sendResponse(socket: WebSocket, response: string, state: States) {
    const resp = { response: response, state: state.toString() };
    //console.log(JSON.stringify(resp));
    const msg = encodeStringWithLength(resp, new ArrayBuffer(0));
    return socket.send(msg);
}

async function waitForSocketClose(socket: WebSocket): Promise<void> {
    return new Promise<void>((resolve) => {
        socket.addEventListener("close", (event) => {
            console.log(`WebSocket connection closed (${event.code})`);

            resolve(); // Resolve the promise when the "close" event is fired
        });
    });
}

function isConn(connObject: Deno.Conn | null): boolean {
    //return conn instanceof Deno.Conn;
    return (connObject !== null && connObject !== undefined &&
        typeof connObject === 'object' &&
        typeof connObject.readable === 'object' &&
        typeof connObject.writable === 'object' &&
        typeof connObject.close === 'function' &&
        typeof connObject.read === 'function' &&
        typeof connObject.write === 'function'); // Add more checks as needed    
}

interface CommandHeader {
    command: string
}


async function localMain() {
    return new Promise<void>(async (resolve) => { // Exits when socket is closed
        async function dataDecoder(data: Blob) {
            const buffer = await data.arrayBuffer();
            const decodedData = decodeStringWithLength(buffer);
            const commandHeader: CommandHeader | undefined = "command" in decodedData.header ? decodedData.header as CommandHeader : undefined;
            if (decodedData.payload.byteLength !== 0 && state !== States.ERROR) {
                if (connOpen === true && tcpConn !== null) {
                    await tcpConn.write(new Uint8Array(decodedData.payload));
                } else {
                    connPayloadQueue.push(decodedData.payload);
                }
            }
            if (commandHeader !== undefined && commandHeader.command !== "ping") {
                console.log(commandHeader);
            }
            if (commandHeader === undefined) {
                // Do nothing
            } else if (commandHeader.command === "ping") {
                await sendResponse(socket, 'pong', state);
            } else if (commandHeader.command === "open" && state === States.READY) {
                state = States.OPENING;
                await sendResponse(socket, 'update', state);
                connEventListener.dispatchEvent(new Event("open"));
                await sleep(.1);
                while (tcpConn === null && state === States.OPENING) { // block until connected polling based
                    await sleep(.1);
                    console.log("Polling conn === null ...");
                }
                if (state === States.OPENING) {
                    state = States.OPEN;
                    await sendResponse(socket, 'update', state);

                    while (connPayloadQueue.length > 0 && tcpConn != null) {
                        const payload = connPayloadQueue.shift();
                        await tcpConn.write(new Uint8Array(decodedData.payload));
                    }
                    // TODO assert length === 0 here?
                    connOpen = true;
                }
            } else if (commandHeader.command === "close" && state === States.OPEN) {
                state = States.CLOSING;
                await sendResponse(socket, "update", state); // we can wait
                connOpen = false;
                if (tcpConn !== null) {
                    tcpConn.close();
                }
            } else if (commandHeader.command === "close" && (state === States.CLOSED || state === States.CLOSING)) {
                // do nothing
            } else if (commandHeader.command === "ack_closed" && state === States.CLOSED) {
                state = States.READY;
                sendResponse(socket, "update", state);
            } else if (commandHeader.command === "reset" && (state === States.READY || state === States.ERROR)) {
                socket.close();
            } else { // TODO replace with try/catch
                console.log("State before error: " + state);
                state = States.ERROR;
                await sendResponse(socket, 'update', state);
                if (tcpConn !== null) { //} && conn instanceof Deno.Conn) { //!== null) {
                    tcpConn.close();
                }
            }
        }
        function addTcpConnEventListeners(eventName: string) {
            connEventListener.addEventListener(eventName, async () => {
                console.log("New connection...");
                try {
                    tcpConn = await Deno.connect({
                        hostname: IP_ADDR,
                        port: PORT,
                    });
                    for await (const chunk of tcpConn.readable) {
                        const payload = {};
                        await socket.send(encodeStringWithLength(payload, chunk.buffer));
                    }
                } catch (error) {
                    if (error instanceof Deno.errors.BadResource) {
                        console.log("Connection closed by client (BadResource)");
                    } else {
                        console.error("Error reading from stream:", error);
                    }
                } finally {
                    connOpen = false;
                    if (state !== States.ERROR) {
                        state = States.CLOSED;
                        sendResponse(socket, "update", state);
                    }

                    tcpConn = null;
                    console.log("Connection closed by client.");
                }
            });
        };

        let state: States = States.INIT;
        let tcpConn: Deno.Conn | null = null;
        let connOpen = false;
        const connEventListener = new EventTarget();
        console.log("Connecting to: " + URL);
        const socket = new WebSocket(URL);
        /*
        socket.headers = {
            "Authorization": `Bearer ${apiKey}`,
            };*/

        const messageQueue = new QueueProcessor<Blob>(dataDecoder);
        let connPayloadQueue: ArrayBuffer[] = [];

        async function handleMessage(event: MessageEvent) {
            messageQueue.addData(event.data);
        }

        socket.addEventListener("message", async (event) => {
            await handleMessage(event);
        });
        socket.addEventListener("open", () => {
            console.log(webSocketState[socket.readyState]);
            state = States.READY;
            sendResponse(socket, "update", state);
        });
        socket.addEventListener("error", (error) => {
            console.error(new Date().toISOString(), "WebSocket error:", error);
        });
        addTcpConnEventListeners("open");


        // WORKAROUND Sometimes Deno Deploy fails to properly shutdown instances and leaves dead connection. Therefor we reset every hour.
        const intervalId = setInterval(function () { // reset the connection frequently           
            if (state !== States.OPEN && state !== States.OPENING && state !== States.CLOSING) { // SSH will timeout if open on a dead connection
                console.log("Closing WebSocket connection");
                socket.close();
            }
        }, CONNECTION_RESET_TIME * 1000); // TODO configurable
        await waitForSocketClose(socket);

        console.log("State: " + state);
        if (!isConn(tcpConn)) {
            console.log("conn === null");
        }
        // TS has issues handling async modified variables
        // @ts-ignore
        if (state === States.OPEN || state === States.OPENING) {
            if (tcpConn !== null) { //} && conn instanceof Deno.Conn) { //!== null) {
                // @ts-ignore
                tcpConn.close();
            }
        }
        clearInterval(intervalId);
        console.log(webSocketState[socket.readyState]);
        resolve(); // Resolve the promise when the "close" event is fired
    });
}


async function waitForMessage(socket: WebSocket): Promise<MessageEvent> {
    return new Promise<MessageEvent>((resolve) => {
        socket.addEventListener('message', (event: MessageEvent) => {
            resolve(event);
        }, { once: true });
    });
}


async function waitForOpen(socket: WebSocket): Promise<Event> {
    return new Promise<Event>((resolve) => {
        socket.addEventListener('open', (event: Event) => {
            resolve(event);
        }, { once: true });
    });
}


interface ResponseHeader { response: string, state: string }

async function remoteMain() {
    console.log(URL);
    const socket = new WebSocket(URL);
    await waitForOpen(socket);
    let remoteState: States | undefined;

    addEventListeners(socket);
    let writerQueue: QueueProcessor<Blob> | null = null;
    while (true) {
        const payload = { command: 'ping' };
        console.log("Starting with a ping");
        socket.send(encodeStringWithLength(payload, new Uint8Array().buffer));
        const event = await waitForMessage(socket); // TODO timeout/retry/unintended or pending messages?
        const buffer = await event.data.arrayBuffer();
        const decoded = decodeStringWithLength(buffer);
        const responseHeader: ResponseHeader = decoded.header as ResponseHeader; // TODO handle undefined
        if (remoteState !== stringToState(responseHeader.state)) {
            remoteState = stringToState(responseHeader.state);
            console.log("Synchronization: " + JSON.stringify(decoded.header));
        }
        if (responseHeader.state === States.READY) {
            break;
        } else {
            console.log("not in ready state");
        }
        if (remoteState === States.ERROR) {
            const payload = { command: 'reset' };
            socket.send(encodeStringWithLength(payload, new Uint8Array().buffer));
            await sleep(1); // let reset complete on local client
        }
        if (remoteState === States.OPEN) {
            const payload = { command: 'close' };
            socket.send(encodeStringWithLength(payload, new Uint8Array().buffer));
            const event = await waitForMessage(socket); // TODO timeout
            const buffer = await event.data.arrayBuffer();
            const decoded = decodeStringWithLength(buffer);
            console.log((decoded.header));

        }
        if (remoteState === States.CLOSED) {
            const payload = { command: 'ack_closed' };
            socket.send(encodeStringWithLength(payload, new Uint8Array().buffer));
            const event = await waitForMessage(socket); // TODO timeout            
            const buffer = await event.data.arrayBuffer();
            const decoded = decodeStringWithLength(buffer);
            console.log((decoded.header));
        }
        if (remoteState === States.CLOSING || remoteState === States.OPENING) {
            await sleep(1); // wait for stable state
        }
    }
    console.log("Synced with local client");
    socket.addEventListener("message", handleMessageEvent);
    let connOpen = false;
    const listener = Deno.listen({ port: PORT, transport: "tcp", hostname: IP_ADDR });
    const intervalId = setInterval(function () { // ping timer
        const initialEventListener = new EventTarget();

        const payload = { command: 'ping' };
        socket.send(encodeStringWithLength(payload, new Uint8Array().buffer));
        // TODO await pong with timeout? remote state?
    }, 5000);

    for await (const conn of listener) {
        // @ts-ignore Typescript has issues with async handling of variables
        if (connOpen === true) {
            // TODO close old connection
            console.log("Connection already in use.");
            conn.closeWrite();
            conn.close();
            continue;
        }
        console.log("New connection");
        connOpen = true;
        handleConnection(conn);
    }
    socket.removeEventListener("message", handleMessageEvent);
    clearInterval(intervalId);

    async function handleMessageEvent(event: MessageEvent) {
        if (writerQueue !== null) {
            writerQueue.addData(event.data);
        } else {
            const buffer = await event.data.arrayBuffer();
            const decoded = decodeStringWithLength(buffer);
            const responseHeader = decoded.header as ResponseHeader;
            if (remoteState !== stringToState(responseHeader.state)) {
                console.log("writerQueue === null && " + JSON.stringify(responseHeader));
                remoteState = stringToState(responseHeader.state);
            }

            if (responseHeader.response === "update" && responseHeader.state === States.CLOSED) { // only complete command chain (no pong)
                await socket.send(encodeStringWithLength({ command: 'ack_closed' }, new Uint8Array().buffer));
            }
        }
    }

    async function handleConnection(conn: Deno.Conn) { // docs Deno.Conn
        let remoteConn = conn;
        const writer = conn.writable;
        async function processWriter(data: Blob) {
            const buffer = await data.arrayBuffer();
            const decoded = decodeStringWithLength(buffer);
            remoteConn.write(new Uint8Array(decoded.payload));
            const responseHeader: ResponseHeader | undefined = "state" in decoded.header ? decoded.header as ResponseHeader : undefined;
            if (responseHeader === undefined) {
                return;
            }
            if (remoteState !== stringToState(responseHeader.state)) {
                remoteState = stringToState(responseHeader.state);
                console.log("State update: " + JSON.stringify(decoded.header));
            }
            if (remoteState === States.CLOSED) {
                console.log("Local connection closed");
                remoteConn.close();
            }
        }
        writerQueue = new QueueProcessor<Blob>(processWriter);
        try {
            await socket.send(encodeStringWithLength({ command: 'open' }, new Uint8Array().buffer));
            console.log("awaiting chunks");
            async function readChunks(remoteConn: Deno.Conn) {
                for await (const chunk of remoteConn.readable) {
                    if (chunk === null) {
                        break;
                    }
                    if (remoteState !== States.CLOSED && remoteState !== States.CLOSING) { // TODO !== States.OPEN
                        const payload = {};
                        await socket.send(encodeStringWithLength(payload, chunk.buffer));
                    }
                }
            }
            await readChunks(remoteConn);
            console.log("awaiting chunks done");
        } catch (error) {
            if (error instanceof Deno.errors.BadResource) {
                console.log("Connection closed by client (BadResource).");
            } else {
                console.error("Error reading from stream:", error);
            }
        } finally {
            writerQueue = null;
            if (remoteState === States.OPEN) {
                await socket.send(encodeStringWithLength({ command: 'close' }, new Uint8Array().buffer));
                while (true) {
                    const event = await waitForMessage(socket); // TODO timeout            
                    const buffer = await event.data.arrayBuffer();
                    const decoded = decodeStringWithLength(buffer);
                    const resp = decoded.header as ResponseHeader;

                    if (stringToState(resp.state) === States.CLOSED) {
                        /* TODO block until fully closed
                        const payload = { command: 'ack_closed' };
                        socket.send(encodeStringWithLength(payload, new Uint8Array()));
                        const event = await waitForMessage(socket); // TODO timeout            
                        const buffer = await event.data.arrayBuffer();
                        const decoded = decodeStringWithLength(buffer);*/
                        break;
                    }
                }
                console.log("Connection closed by client.");

            }
            connOpen = false;

        }
    }
    return;
}



if (REMOTE === true) {
    console.log("Remote mode");
    await remoteMain();
} else {
    while (true) {
        const startTime = performance.now();

        await localMain();

        const endTime = performance.now();
        const executionTime = (endTime - startTime) / 1000;
        // avoid poll flooding in case of connection issues
        if (executionTime < RETRY_TIME) { // only retry once every 30 seconds
            const sleepTime = Math.max(0, RETRY_TIME - executionTime);
            await sleep(sleepTime);
        } else { // immediatly retry once
            const SLEEP_TIME = 5;
            await sleep(SLEEP_TIME);
        }
    }
}
