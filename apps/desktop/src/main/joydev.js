'use strict';
// Reads Steam's virtual Xbox pads straight from /dev/input/js* (the Linux joystick API).
//
// Why: with two controllers, Steam Input creates two virtual pads ("Microsoft X-Box 360 pad 0" and "... pad 1", both
// 28de:11ff). Both are uinput devices under /sys/devices/virtual/input/, so Chromium's Linux gamepad code, which pairs
// device nodes by their parent sysfs path, treats them as one device and drops pad 0: only one controller works.
// Reading joydev ourselves sees every pad. Other controllers (Steam Input off, desktop) still go through the Gamepad API.
const fs = require('fs');
const path = require('path');

const JS_EVENT_BUTTON = 0x01;
const JS_EVENT_AXIS = 0x02;
const JS_EVENT_INIT = 0x80;
const EVENT_SIZE = 8;

/** Steam's virtual pads (and other xpad-style pads) that we read ourselves. */
function isSteamVirtualPad({ name = '', vendor = '' }) {
  return vendor.toLowerCase() === '28de' || /X-Box 360 pad \d+|Steam Virtual Gamepad/i.test(name);
}

/** Parse joydev events from a buffer into the state; returns the bytes consumed. */
function applyEvents(buf, state) {
  let off = 0;
  while (off + EVENT_SIZE <= buf.length) {
    const value = buf.readInt16LE(off + 4);
    const type = buf.readUInt8(off + 6) & ~JS_EVENT_INIT;
    const number = buf.readUInt8(off + 7);
    if (type === JS_EVENT_BUTTON) state.buttons[number] = value;
    else if (type === JS_EVENT_AXIS) state.axes[number] = value;
    off += EVENT_SIZE;
  }
  return off;
}

/**
 * Convert xpad joydev state (buttons A B X Y LB RB Back Start Guide LS RS; axes LX LY LT RX RY RT HatX HatY) into a
 * "standard"-mapping gamepad snapshot like the Gamepad API's.
 */
function toStandard(state) {
  const b = (i) => (state.buttons[i] ? 1 : 0);
  const ax = (i) => (state.axes[i] || 0) / 32767;
  const trig = (i) => Math.max(0, ((state.axes[i] || -32767) + 32767) / 65534);
  const hx = state.axes[6] || 0;
  const hy = state.axes[7] || 0;
  const vals = [b(0), b(1), b(2), b(3), b(4), b(5), trig(2), trig(5), b(6), b(7), b(9), b(10),
    hy < -16000 ? 1 : 0, hy > 16000 ? 1 : 0, hx < -16000 ? 1 : 0, hx > 16000 ? 1 : 0, b(8)];
  return {
    buttons: vals.map((v) => ({ pressed: v > 0.5, value: v })),
    axes: [ax(0), ax(1), ax(3), ax(4)],
  };
}

class JoydevReader {
  constructor({ onChange, log, dir = '/dev/input', sysDir = '/sys/class/input' }) {
    this.onChange = onChange;
    this.log = log || (() => {});
    this.dir = dir;
    this.sysDir = sysDir;
    this.devs = new Map(); // node name (js0) -> { fd, name, state, index }
    this.timer = null;
    this.scanTimer = null;
  }

  start() {
    this.scan();
    this.scanTimer = setInterval(() => this.scan(), 2000);
    this.timer = setInterval(() => this.readAll(), 8);
    return this;
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.scanTimer);
    for (const node of [...this.devs.keys()]) this.close(node, 'stopped');
  }

  info(node) {
    const d = path.join(this.sysDir, node, 'device');
    const read = (f) => { try { return fs.readFileSync(path.join(d, f), 'utf8').trim(); } catch { return ''; } };
    return { name: read('name'), vendor: read('id/vendor'), product: read('id/product') };
  }

  scan() {
    let nodes = [];
    try { nodes = fs.readdirSync(this.dir).filter((n) => /^js\d+$/.test(n)); } catch { return; }
    for (const node of nodes) {
      if (this.devs.has(node)) continue;
      const info = this.info(node);
      if (!isSteamVirtualPad(info)) continue;
      let fd;
      try {
        fd = fs.openSync(path.join(this.dir, node), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      } catch (e) {
        if (!this.warned) { this.warned = true; this.log(`[joydev] cannot open ${node}: ${e.code}`); }
        continue;
      }
      const index = Number(node.slice(2));
      this.devs.set(node, { fd, info, index, state: { buttons: [], axes: [] }, buf: Buffer.alloc(EVENT_SIZE * 64) });
      this.log(`[joydev] opened ${node}: ${info.name} (${info.vendor}:${info.product})`);
    }
    for (const node of [...this.devs.keys()]) if (!nodes.includes(node)) this.close(node, 'removed');
  }

  close(node, why) {
    const d = this.devs.get(node);
    if (!d) return;
    try { fs.closeSync(d.fd); } catch { /* ignore */ }
    this.devs.delete(node);
    this.log(`[joydev] closed ${node} (${why})`);
    this.onChange({ index: d.index, id: d.info.name, gone: true });
  }

  readAll() {
    for (const [node, d] of this.devs) {
      let changed = false;
      for (;;) {
        let n;
        try { n = fs.readSync(d.fd, d.buf, 0, d.buf.length, null); } catch (e) {
          if (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK') break;
          this.close(node, e.code);
          break;
        }
        if (!n) break;
        applyEvents(d.buf.subarray(0, n), d.state);
        changed = true;
        if (n < d.buf.length) break;
      }
      if (changed) this.onChange({ index: d.index, id: `${d.info.name} (joydev ${d.info.vendor}:${d.info.product})`, ...toStandard(d.state) });
    }
  }

  /** Re-send every pad's current state (e.g. after the page reloads and missed the first events). */
  replay() {
    for (const d of this.devs.values()) this.onChange({ index: d.index, id: `${d.info.name} (joydev ${d.info.vendor}:${d.info.product})`, ...toStandard(d.state) });
  }

  count() { return this.devs.size; }
}

module.exports = { JoydevReader, applyEvents, toStandard, isSteamVirtualPad };
