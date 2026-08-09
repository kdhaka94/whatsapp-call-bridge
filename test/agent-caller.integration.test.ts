/**
 * Integration tests for AgentCaller — verifies the full audio bridge wiring
 * between the WhatsApp call and the ElevenLabs agent, using mock dependencies.
 *
 * These tests do NOT make real network calls. They inject:
 * - MockWhatsAppClient (returns MockActiveCall)
 * - A bridge factory that creates a real ElevenLabsBridge backed by MockWebSocket
 *
 * The tests verify:
 * 1. Full audio flow: callee audio → user_audio_chunk sent to ElevenLabs
 * 2. Full audio flow: agent audio → pushAudio into the call
 * 3. Interruption → flushAudio called on the call
 * 4. Call ended → bridge closed, session emits "ended"
 * 5. Dynamic variables passed to initiation
 * 6. Session events (ringing, connected, transcript, agentResponse)
 */
import { describe, it, expect, vi } from "vitest";
import { AgentCaller } from "../src/client.js";
import {
  MockWhatsAppClient,
  MockWebSocket,
  sendInitMetadata,
  sendAudioEvent,
  sendInterruption,
  sendPing,
  extractUserAudioChunks,
} from "./helpers/mocks.js";
import { ElevenLabsBridge } from "../src/elevenlabs/bridge.js";
import { base64ToFloat32 } from "../src/audio/pcm.js";

const baseConfig = {
  authDir: "./test-auth",
  elevenlabs: { agentId: "test-agent" },
};

/** Create an AgentCaller with mocked WhatsApp + a bridge backed by a captured MockWebSocket. */
const createTestAgent = () => {
  const whatsapp = new MockWhatsAppClient();
  let capturedMock: MockWebSocket | null = null;

  const bridgeFactory = (opts: any) => {
    const mock = new MockWebSocket();
    capturedMock = mock;
    return new ElevenLabsBridge({ ...opts, webSocketFactory: () => mock });
  };

  const caller = new AgentCaller({
    ...baseConfig,
    _whatsappClient: whatsapp,
    _bridgeFactory: bridgeFactory,
  });

  return { caller, whatsapp, getMock: () => capturedMock! };
};

/**
 * Place a call and drive the mock WebSocket through initiation.
 * Must NOT await caller.call() directly — bridge.connect() blocks until the
 * mock WS is driven, so we store the promise, drive the mock, then await.
 */
const placeCall = async (caller: any, getMock: () => MockWebSocket, number = "+1234567890", opts: any = {}) => {
  const callP = caller.call(number, opts);
  const mock = getMock();
  mock.serverOpen();
  sendInitMetadata(mock);
  const session = await callP;
  return { session, mock };
};

describe("AgentCaller integration", () => {
  it("connects to WhatsApp, places a call, and opens the ElevenLabs bridge", async () => {
    const { caller, whatsapp, getMock } = createTestAgent();
    await caller.connect();
    expect(whatsapp.connected).toBe(true);

    const { session, mock } = await placeCall(caller, getMock);

    expect(whatsapp.calls).toHaveLength(1);
    expect(whatsapp.calls[0].number).toBe("1234567890");
    expect(whatsapp.calls[0].opts.audioSource).toBe("silence");
    expect(session).toBeDefined();
    session.end();
    caller.disconnect();
  });

  it("flows callee audio → ElevenLabs as user_audio_chunk", async () => {
    const { caller, whatsapp, getMock } = createTestAgent();
    await caller.connect();
    const { session, mock } = await placeCall(caller, getMock);
    mock.sent.length = 0; // clear initiation

    // Simulate the callee speaking — WhatsApp emits audio frames.
    const calleeAudio = Float32Array.from([0.1, 0.2, 0.3, -0.1, -0.2]);
    whatsapp.lastCall!.emitAudio(calleeAudio);

    // The bridge should have sent a user_audio_chunk with the encoded audio.
    const chunks = extractUserAudioChunks(mock.sent);
    expect(chunks).toHaveLength(1);
    const decoded = base64ToFloat32(chunks[0]);
    expect(decoded.length).toBe(calleeAudio.length);
    for (let i = 0; i < calleeAudio.length; i++) {
      expect(Math.abs(decoded[i] - calleeAudio[i])).toBeLessThan(1 / 32767);
    }
    session.end();
    caller.disconnect();
  });

  it("flows agent audio → call.pushAudio (callee hears the agent)", async () => {
    const { caller, whatsapp, getMock } = createTestAgent();
    await caller.connect();
    const { session, mock } = await placeCall(caller, getMock);

    // Simulate the ElevenLabs agent speaking — send an audio event.
    const agentAudio = Float32Array.from([0.5, -0.5, 0.25, -0.25]);
    sendAudioEvent(mock, agentAudio);

    // The call should have received the audio via pushAudio.
    expect(whatsapp.lastCall!.pushAudioCalls).toHaveLength(1);
    const pushed = whatsapp.lastCall!.pushAudioCalls[0];
    expect(pushed.length).toBe(agentAudio.length);
    for (let i = 0; i < agentAudio.length; i++) {
      expect(Math.abs(pushed[i] - agentAudio[i])).toBeLessThan(1 / 32767);
    }
    session.end();
    caller.disconnect();
  });

  it("flushes the feeder on ElevenLabs interruption (stops agent mid-word)", async () => {
    const { caller, getMock } = createTestAgent();
    await caller.connect();
    const { session, mock } = await placeCall(caller, getMock);

    const onInterruption = vi.fn();
    session.on("interruption", onInterruption);

    sendInterruption(mock);

    expect((session as any).activeCall.flushAudioCalls).toBe(1);
    expect(onInterruption).toHaveBeenCalledTimes(1);
    session.end();
    caller.disconnect();
  });

  it("closes the bridge and emits 'ended' when the WhatsApp call ends", async () => {
    const { caller, whatsapp, getMock } = createTestAgent();
    await caller.connect();
    const { session, mock } = await placeCall(caller, getMock);

    const onEnded = vi.fn();
    session.on("ended", onEnded);

    // Simulate the callee hanging up.
    whatsapp.lastCall!.emitEnded("remote_end");

    expect(onEnded).toHaveBeenCalledWith("remote_end");
    // The bridge should be closed (readyState 3).
    expect(mock.readyState).toBe(3);
    caller.disconnect();
  });

  it("emits ringing and connected session events", async () => {
    const { caller, whatsapp, getMock } = createTestAgent();
    await caller.connect();
    const { session, mock } = await placeCall(caller, getMock);

    const ringing = vi.fn();
    const connected = vi.fn();
    session.on("ringing", ringing);
    session.on("connected", connected);

    whatsapp.lastCall!.emitRinging();
    expect(ringing).toHaveBeenCalledTimes(1);

    whatsapp.lastCall!.emitConnected();
    expect(connected).toHaveBeenCalledTimes(1);
    session.end();
    caller.disconnect();
  });

  it("emits transcript and agentResponse session events from the bridge", async () => {
    const { caller, getMock } = createTestAgent();
    await caller.connect();
    const { session, mock } = await placeCall(caller, getMock);

    const transcripts: string[] = [];
    const responses: string[] = [];
    session.on("transcript", (t) => transcripts.push(t));
    session.on("agentResponse", (t) => responses.push(t));

    mock.serverSend(JSON.stringify({
      type: "user_transcript",
      user_transcript_event: { transcript: "I need help", transcript_id: 1 },
    }));
    mock.serverSend(JSON.stringify({
      type: "agent_response",
      agent_response_event: { response: "Sure, what do you need?", response_id: 2 },
    }));

    expect(transcripts).toEqual(["I need help"]);
    expect(responses).toEqual(["Sure, what do you need?"]);
    session.end();
    caller.disconnect();
  });

  it("passes dynamic variables to the ElevenLabs initiation", async () => {
    const { caller, getMock } = createTestAgent();
    await caller.connect();
    const { session, mock } = await placeCall(caller, getMock, "+1234567890", {
      dynamicVariables: { customer_name: "Daniele" },
    });

    // The first sent message should be the initiation with dynamic_variables.
    const initiation = JSON.parse(mock.sent[0]);
    expect(initiation.type).toBe("conversation_initiation_client_data");
    expect(initiation.dynamic_variables).toEqual({ customer_name: "Daniele" });
    session.end();
    caller.disconnect();
  });

  it("replies to ElevenLabs ping with pong (keepalive)", async () => {
    const { caller, getMock } = createTestAgent();
    await caller.connect();
    const { session, mock } = await placeCall(caller, getMock);
    mock.sent.length = 0;

    sendPing(mock, 99);

    const pong = JSON.parse(mock.sent[0]);
    expect(pong.type).toBe("pong");
    expect(pong.event_id).toBe(99);
    session.end();
    caller.disconnect();
  });

  it("session.end() hangs up the call and closes the bridge", async () => {
    const { caller, whatsapp, getMock } = createTestAgent();
    await caller.connect();
    const { session, mock } = await placeCall(caller, getMock);

    await session.end();

    expect((session as any).activeCall.endCalls).toBe(1);
    expect(mock.readyState).toBe(3);
    caller.disconnect();
  });
});
