// Android app (mobile/): the WebView has no Web Bluetooth – this puts the part of navigator.bluetooth that mesh.js
// uses (requestDevice, getDevices, GATT connect/read/write/notifications) on top of the native plugin
// @capacitor-community/bluetooth-le. In a browser it does nothing.
'use strict';

(() => {
  const ble = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BluetoothLe;
  if (!ble || navigator.bluetooth) return;

  const hex = bytes => Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength), b => b.toString(16).padStart(2, '0')).join('');
  const view = h => { const s = String(h || '').replace(/\s/g, ''); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return new DataView(a.buffer); };
  const KNOWN = 'eud.bleKnown'; // radios chosen before (Web Bluetooth's getDevices after a restart)
  const known = () => { try { return JSON.parse(localStorage.getItem(KNOWN) || '{}'); } catch (e) { return {}; } };
  let ready = null;
  const init = () => ready || (ready = ble.initialize({ androidNeverForLocation: false }).catch(e => { ready = null; throw e; }));

  class Emitter {
    constructor() { this.l = {}; }
    addEventListener(t, f) { (this.l[t] = this.l[t] || []).push(f); }
    removeEventListener(t, f) { this.l[t] = (this.l[t] || []).filter(x => x !== f); }
    emit(t, e) { for (const f of this.l[t] || []) try { f(e); } catch (err) { /* listener error */ } }
  }

  const devices = new Map();
  function device(id, name) {
    if (devices.has(id)) return devices.get(id);
    const d = new Emitter();
    d.id = id;
    d.name = name || '';
    let offDisc = null;
    const chars = [];
    d.gatt = {
      connected: false,
      async connect() {
        await init();
        if (!offDisc) offDisc = await ble.addListener('disconnected|' + id, () => {
          d.gatt.connected = false;
          d.emit('gattserverdisconnected', { target: d });
        });
        await ble.connect({ deviceId: id, timeout: 15000 });
        d.gatt.connected = true;
        return server;
      },
      disconnect() {
        d.gatt.connected = false;
        for (const c of chars.splice(0)) if (c.off) c.off.remove();
        ble.disconnect({ deviceId: id }).catch(() => {});
      },
    };
    const server = {
      async getPrimaryService(svc) {
        const service = String(svc).toLowerCase();
        return {
          async getCharacteristic(chr) {
            const characteristic = String(chr).toLowerCase();
            const args = { deviceId: id, service, characteristic };
            const c = new Emitter();
            chars.push(c);
            c.readValue = async () => view((await ble.read(args)).value);
            c.writeValueWithResponse = bytes => ble.write({ ...args, value: hex(bytes) });
            c.writeValue = c.writeValueWithResponse;
            c.startNotifications = async () => {
              if (!c.off) c.off = await ble.addListener(`notification|${id}|${service}|${characteristic}`, r => c.emit('characteristicvaluechanged', { target: { value: view(r && r.value) } }));
              await ble.startNotifications(args);
              return c;
            };
            return c;
          },
        };
      },
    };
    devices.set(id, d);
    return d;
  }

  navigator.bluetooth = {
    async requestDevice(opts) {
      await init();
      const services = [].concat(...((opts && opts.filters) || []).map(f => f.services || [])).map(s => String(s).toLowerCase());
      let r;
      try { r = await ble.requestDevice({ services }); } catch (e) {
        const err = new Error(/cancel/i.test(e.message) ? 'User cancelled the requestDevice() chooser.' : e.message);
        err.name = 'NotFoundError';
        throw err;
      }
      const k = known();
      k[r.deviceId] = r.name || '';
      try { localStorage.setItem(KNOWN, JSON.stringify(k)); } catch (e) { /* private mode */ }
      return device(r.deviceId, r.name);
    },
    async getDevices() {
      return Object.entries(known()).map(([id, name]) => device(id, name));
    },
  };
})();
