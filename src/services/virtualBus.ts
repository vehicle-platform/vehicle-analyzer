import { CanFrame, DbcMessageDef } from '../types/can';
import { Defs, DidDef, encodeDid } from '../defs/model';
import { encodeFrameSignals } from './dbcParser';
import { e2eProtect } from './e2e';
import { checkTesterPolicy } from './udsComposer';

/**
 * Simulated CL250 + platform buses for development without hardware.
 *
 * Everything on the wire follows vehicle-defs: platform frames are packed from
 * platform.dbc (IDs, layouts, cycle times, E2E DataIDs), the vehicle bus carries the
 * UDS conversation of uds/vehicle_cl250.yaml (addressing, session start, tester
 * present, DID poll periods, formulas). Only the physics are made up, and they are
 * labelled as simulation. The simulated ECU answers the verified DIDs and refuses the
 * others with NRC 0x31, as an ECU that does not serve them would.
 */

const TICK_MS = 10;
/** Ride cycle of the simulation, in seconds (key-on, crank, idle, ride, idle, stop). */
const CYCLE = { keyOn: 4, crankEnd: 5, rideStart: 40, cruiseStart: 60, cruiseEnd: 80, rideEnd: 100, engineOff: 125, end: 145 };

interface PendingRequest {
  payload: number[];
  dueSec: number;
}

export class VirtualCanBus {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private onFrame: ((frame: CanFrame) => void) | null = null;

  // Physics
  private t = 0;
  private rpm = 0;
  private speed = 0;
  private throttle = 0;
  private coolant = 30;
  private battery = 12.6;
  private lean = 0;

  // Platform bus schedule and E2E counters
  private nextTx = new Map<number, number>();
  private counters = new Map<number, number>();
  private readonly platformMsgs: DbcMessageDef[];

  // Vehicle bus tester (rt-core role) and simulated ECU
  private sessionStarted = false;
  private dtcReadDone = false;
  private nextTesterPresent = 0;
  private nextPoll = new Map<number, number>();
  private stoppedDids = new Set<number>();
  private inFlight: PendingRequest | null = null;
  private ecuQueue: { atSec: number; payload: number[] }[] = [];
  private didCache = new Map<string, { value: number; t: number }>();

  constructor(private readonly defs: Defs) {
    this.platformMsgs = defs.platform.messages.filter((m) => (m.cycleTimeMs ?? 0) > 0);
  }

  public start(callback: (frame: CanFrame) => void) {
    this.onFrame = callback;
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => this.tick(), TICK_MS);
  }

  public stop() {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  public isActive(): boolean {
    return this.intervalId !== null;
  }

  /**
   * Sends a composer request to the simulated ECU. Only here may the analyzer put a
   * request on a bus, and only one that passes tester_policy.
   */
  public injectTesterRequest(payload: number[]): { ok: boolean; error?: string } {
    const verdict = checkTesterPolicy(this.defs, payload);
    if (!verdict.allowed) return { ok: false, error: verdict.reason };
    if (payload.length > 7) return { ok: false, error: 'requests are Single Frames only (D-059)' };
    this.sendRequest(payload);
    return { ok: true };
  }

  /** Advances the simulation by one tick (public for tests). */
  public tick() {
    this.t += TICK_MS / 1000;
    this.stepPhysics(TICK_MS / 1000);
    this.stepTester();
    this.stepEcu();
    this.stepPlatform();
  }

  public get timeSec() {
    return this.t;
  }

  // ---------------------------------------------------------------- physics

  private stepPhysics(dt: number) {
    const c = this.t % CYCLE.end;
    const running = c >= CYCLE.keyOn && c < CYCLE.engineOff;

    if (c < CYCLE.keyOn || c >= CYCLE.engineOff) {
      this.rpm = 0;
      this.speed = 0;
      this.throttle = 0;
      this.battery = 12.6;
    } else if (c < CYCLE.crankEnd) {
      const k = (c - CYCLE.keyOn) / (CYCLE.crankEnd - CYCLE.keyOn);
      this.rpm = k < 0.6 ? 250 : 250 + ((k - 0.6) / 0.4) * 1150;
      this.battery = k < 0.6 ? 10.3 : 13.2;
      this.throttle = 0;
    } else if (c < CYCLE.rideStart || c >= CYCLE.rideEnd) {
      this.rpm = 1350 + 25 * Math.sin(this.t * 3.1);
      this.speed = Math.max(0, this.speed - 12 * dt);
      this.throttle = 0;
      this.battery = 14.1;
    } else {
      let target: number;
      if (c < CYCLE.cruiseStart) target = 90 * ((c - CYCLE.rideStart) / (CYCLE.cruiseStart - CYCLE.rideStart));
      else if (c < CYCLE.cruiseEnd) target = 90;
      else target = 90 * (1 - (c - CYCLE.cruiseEnd) / (CYCLE.rideEnd - CYCLE.cruiseEnd));
      this.speed += Math.max(-15 * dt, Math.min(8 * dt, target - this.speed));
      const accelerating = target > this.speed + 0.5;
      this.throttle = c >= CYCLE.cruiseStart && c < CYCLE.cruiseEnd ? 22 : accelerating ? 45 : 2;
      // Engine speed from a simple gear choice (simulation only; the real gear estimate is a derived signal).
      const gear = Math.max(1, Math.min(6, Math.ceil(this.speed / 18)));
      this.rpm = Math.max(1400, (this.speed * 1000) / (gear * 2.4) + 900);
      this.battery = 14.2;
    }

    if (running) this.coolant = Math.min(92, this.coolant + 1.2 * dt);
    else this.coolant = Math.max(30, this.coolant - 0.05 * dt);

    const weave = this.speed > 25 ? Math.min(1, (this.speed - 25) / 30) : 0;
    this.lean = 38 * weave * Math.sin((2 * Math.PI * this.t) / 9);
  }

  // ---------------------------------------------------------------- vehicle bus

  private emit(bus: string, id: number, extended: boolean, data: number[]) {
    this.onFrame?.({
      id,
      idHex: `0x${id.toString(16).toUpperCase().padStart(extended ? 8 : 3, '0')}`,
      bus,
      dlc: data.length,
      data,
      timestamp: this.t,
      deltaMs: 0,
      isExtended: extended,
      periodMs: 0,
      frequencyHz: 0,
      count: 1,
    });
  }

  private singleFrame(payload: number[]): number[] {
    const d = [payload.length, ...payload];
    while (d.length < 8) d.push(this.defs.vehicle.paddingByte);
    return d;
  }

  private sendRequest(payload: number[]) {
    const a = this.defs.vehicle.addressing.primary;
    this.emit('vehicle', a.requestId, a.extended, this.singleFrame(payload));
    const answer = this.ecuAnswer(payload);
    if (answer) this.ecuQueue.push({ atSec: this.t + 0.008, payload: answer });
  }

  private stepTester() {
    const v = this.defs.vehicle;
    if (this.inFlight && this.t > this.inFlight.dueSec) this.inFlight = null;
    if (this.inFlight) return;

    // D-019/D-020: extended session first, retried until accepted.
    if (!this.sessionStarted) {
      if (this.t >= 0.3) {
        this.sendRequest(v.session.startRequest);
        this.inFlight = { payload: v.session.startRequest, dueSec: this.t + v.timing.responseTimeoutBaseMs / 1000 };
      }
      return;
    }

    if (this.t >= this.nextTesterPresent) {
      this.nextTesterPresent = this.t + v.session.testerPresentPeriodMs / 1000;
      this.sendRequest(v.session.testerPresentRequest); // suppressPosRsp: no answer, nothing in flight
      return;
    }

    // D-080: the DTC presence read once at key-on.
    if (!this.dtcReadDone && v.dtcSnapshot) {
      this.dtcReadDone = true;
      const req = [0x19, 0x02, v.dtcSnapshot.statusMask];
      this.sendRequest(req);
      this.inFlight = { payload: req, dueSec: this.t + v.timing.responseTimeoutBaseMs / 1000 };
      return;
    }

    // DID polling at the defs poll periods, the most overdue first, one in flight.
    let best: DidDef | null = null;
    let bestLate = -Infinity;
    for (const d of v.dids) {
      if (this.stoppedDids.has(d.did)) continue;
      const due = this.nextPoll.get(d.did) ?? 0;
      const late = this.t - due;
      if (late >= 0 && late > bestLate) {
        best = d;
        bestLate = late;
      }
    }
    if (!best) return;
    this.nextPoll.set(best.did, this.t + best.pollPeriodMs / 1000);
    const req = [0x22, best.did >> 8, best.did & 0xff];
    this.sendRequest(req);
    this.inFlight = { payload: req, dueSec: this.t + v.timing.responseTimeoutBaseMs / 1000 };
  }

  /** Physical value the simulated ECU reports for a DID, or null when it does not serve it. */
  private ecuValue(def: DidDef): number | null {
    if (!def.verified) return null;
    switch (def.name) {
      case 'ENGINE_SPEED':
        return this.rpm;
      case 'VEHICLE_SPEED':
        return this.speed;
      case 'THROTTLE_POS':
        return this.throttle;
      case 'COOLANT_TEMP':
        return this.coolant;
      case 'BATTERY_VOLTAGE':
        return this.battery;
      default:
        return null;
    }
  }

  private ecuAnswer(req: number[]): number[] | null {
    const sid = req[0];
    const nrc = (code: number) => [0x7f, sid, code];
    const suppress = (req[1] ?? 0) & this.defs.iso.suppressPosRspBit;
    switch (sid) {
      case 0x10:
        // P2 = 50 ms (1 ms units), P2* = 5000 ms (10 ms units)
        return [0x50, req[1] & 0x7f, 0x00, 0x32, 0x01, 0xf4];
      case 0x3e:
        return suppress ? null : [0x7e, req[1] & 0x7f];
      case 0x22: {
        if (req.length !== 3) return nrc(0x13);
        const did = (req[1] << 8) | req[2];
        const def = this.defs.vehicle.dids.find((d) => d.did === did);
        const value = def ? this.ecuValue(def) : null;
        if (!def || value === null) return nrc(0x31);
        return [0x62, req[1], req[2], ...encodeDid(def, value)];
      }
      case 0x19: {
        const sub = req[1] & 0x7f;
        if (sub === 0x01) return [0x59, 0x01, 0xff, 0x01, 0x00, 0x00];
        if (sub === 0x02 || sub === 0x0a) return [0x59, sub, 0xff]; // no stored DTC in the simulation
        return nrc(0x31);
      }
      default:
        return nrc(0x11);
    }
  }

  private stepEcu() {
    const a = this.defs.vehicle.addressing.primary;
    while (this.ecuQueue.length && this.ecuQueue[0].atSec <= this.t) {
      const { payload } = this.ecuQueue.shift()!;
      if (payload.length > 7) continue; // the simulated answers all fit a Single Frame
      this.emit('vehicle', a.responseId, a.extended, this.singleFrame(payload));
      this.onEcuAnswer(payload);
    }
  }

  /** The simulated tester's view of an answer: session state, DID cache, D-068 stop. */
  private onEcuAnswer(p: number[]) {
    const req = this.inFlight?.payload;
    if (p[0] === 0x50) this.sessionStarted = true;
    if (p[0] === 0x62) {
      const did = (p[1] << 8) | p[2];
      const def = this.defs.vehicle.dids.find((d) => d.did === did);
      if (def) {
        const raw = p.slice(3);
        let v = 0;
        for (const b of raw) v = v * 256 + b;
        this.didCache.set(def.name, { value: (v * def.factorNum) / def.factorDen + def.offset, t: this.t });
      }
    }
    if (p[0] === 0x7f && p[2] === 0x31 && req && req[0] === 0x22) {
      this.stoppedDids.add((req[1] << 8) | req[2]); // D-068: an unverified DID that is out of range stops
    }
    if (req && (p[0] === req[0] + 0x40 || (p[0] === 0x7f && p[1] === req[0]))) this.inFlight = null;
  }

  // ---------------------------------------------------------------- platform bus

  private didValue(name: string): { value: number; valid: boolean; ageMs: number } {
    const def = this.defs.vehicle.dids.find((d) => d.name === name);
    const c = this.didCache.get(name);
    if (!def || !c) return { value: 0, valid: false, ageMs: 0 };
    const ageMs = (this.t - c.t) * 1000;
    return { value: c.value, valid: ageMs <= def.staleAfterMs, ageMs };
  }

  /** Physical values per message, by signal name (what rt-core / the safety partition would send). */
  private platformValues(msg: DbcMessageDef): Record<string, number> | null {
    const uptime = Math.floor(this.t);
    // v0.29.0: heartbeat signals carry a per-node prefix (RT_CORE_NODE_MODE, ...); match by suffix.
    const heartbeat: Record<string, number> = {};
    for (const sig of msg.signals) {
      if (sig.name.endsWith('NODE_MODE')) heartbeat[sig.name] = 1;
      else if (sig.name.endsWith('ERROR_COUNT')) heartbeat[sig.name] = 0;
      else if (sig.name.endsWith('UPTIME')) heartbeat[sig.name] = uptime;
    }
    const ekfConverged = this.t > 2;
    const mu = 0.9;
    switch (msg.name) {
      case 'EkfLean':
        return ekfConverged
          ? { LEAN_ANGLE_STATE: 0, LEAN_ANGLE: this.lean, LEAN_ANGLE_QUALITY: 90 }
          : { LEAN_ANGLE_STATE: 3, LEAN_ANGLE: 0, LEAN_ANGLE_QUALITY: 0 };
      case 'VehicleSpeed': {
        const s = this.didValue('VEHICLE_SPEED');
        return { VEHICLE_SPEED_VALID: s.valid ? 1 : 0, VEHICLE_SPEED: s.value, VEHICLE_SPEED_AGE: s.ageMs };
      }
      case 'EkfFrictionMass':
        return ekfConverged
          ? { FRICTION_COEFF_STATE: 0, TOTAL_MASS_STATE: 0, FRICTION_COEFF: mu, FRICTION_COEFF_QUALITY: 80, TOTAL_MASS: 245, TOTAL_MASS_QUALITY: 70 }
          : { FRICTION_COEFF_STATE: 3, TOTAL_MASS_STATE: 3 };
      case 'SafetyWarningStatus': {
        // Layer 1 rule of limits/platform_limits.yaml: u = tan|lean| / mu.
        const { kYellow, kRed } = this.defs.limits;
        let level = 0;
        let source = 0;
        if (ekfConverged) {
          const u = Math.tan((Math.abs(this.lean) * Math.PI) / 180) / mu;
          level = u < kYellow ? 1 : u < kRed ? 2 : 3;
          source = 1;
        }
        return { CORNERING_LEVEL: level, CORNERING_SOURCE: source, BSM_LEFT: 1, BSM_RIGHT: 1, IMMOBILIZER_STATE: 1 };
      }
      case 'HeartbeatRtCore':
      case 'HeartbeatSafety':
      case 'HeartbeatConn':
      case 'HeartbeatLinux':
        return heartbeat;
      case 'VehicleEngine': {
        const rpm = this.didValue('ENGINE_SPEED');
        const bat = this.didValue('BATTERY_VOLTAGE');
        const ect = this.didValue('COOLANT_TEMP');
        const tps = this.didValue('THROTTLE_POS');
        return {
          ENGINE_SPEED: rpm.value,
          BATTERY_VOLTAGE: bat.value,
          COOLANT_TEMP: ect.value,
          THROTTLE_POS: tps.value,
          ENGINE_SPEED_VALID: rpm.valid ? 1 : 0,
          BATTERY_VOLTAGE_VALID: bat.valid ? 1 : 0,
          COOLANT_TEMP_VALID: ect.valid ? 1 : 0,
          THROTTLE_POS_VALID: tps.valid ? 1 : 0,
          ECU_PRESENT: this.sessionStarted ? 1 : 0,
        };
      }
      case 'SafetyRequest':
        return { IGNITION_STATE: 2, PARK_MODE: 1, IMMOBILIZER_LOCK_REQUEST: 0 };
      default:
        return null; // a message the simulation does not model is not sent
    }
  }

  private stepPlatform() {
    for (const msg of this.platformMsgs) {
      const due = this.nextTx.get(msg.id) ?? 0;
      if (this.t + 1e-9 < due) continue;
      this.nextTx.set(msg.id, Math.max(due, this.t - 1) + msg.cycleTimeMs! / 1000);
      const values = this.platformValues(msg);
      if (!values) continue;
      let data = encodeFrameSignals(msg, values);
      if (msg.e2e) {
        const counter = this.counters.get(msg.id) ?? 0;
        this.counters.set(msg.id, (counter + 1) & 0x0f);
        data = e2eProtect(msg.e2e.dataId, data, counter);
      }
      this.emit('platform', msg.id, msg.isExtended ?? false, data);
    }
  }
}
