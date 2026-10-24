// Mock OpenTAKServer (only the web API parts this app uses) for tests.

const http = require('http');

function createMockOts({ admin = 'otsadmin', password = 'otspass' } = {}) {
  const state = {
    users: {},        // username -> { password, active, roles }
    groups: new Set(),
    members: [],      // { username, group, direction }
    euds: [],         // { uid, callsign, username }
    profiles: [],     // { eud_uid, preference_key, preference_value }
    tokens: {},       // username -> counter
    videos: {},       // path -> { source, host }
    missions: {},     // name -> { name, description, creator_uid, password, groups }
    mesh: [],         // { name, url, … }
    calls: [],
  };
  const TOKEN = 'tok-' + Math.random().toString(36).slice(2);

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const json = body ? JSON.parse(body) : {};
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const fail = (status, error) => send(status, { success: false, error });
      state.calls.push(`${req.method} ${u.pathname}`);

      if (u.pathname === '/api/login' && req.method === 'POST') {
        // like OTS: every active user can log in; only the admin may then use the admin API
        const u = state.users[json.username];
        if (u && u.active && u.password === json.password) return send(200, { meta: { code: 200 }, response: { csrf_token: 'c', user: { authentication_token: 'user-' + json.username } } });
        if (json.username !== admin || json.password !== password) return send(400, { meta: { code: 400 }, response: { errors: ['Invalid password'] } });
        return send(200, { meta: { code: 200 }, response: { csrf_token: 'c', user: { authentication_token: TOKEN } } });
      }
      if (u.pathname === '/api/truststore') { res.writeHead(200, { 'Content-Type': 'application/x-pkcs12' }); return res.end(Buffer.from('P12DATA')); }
      if (req.headers['authentication-token'] !== TOKEN) return send(401, { meta: { code: 401 } });

      if (u.pathname === '/api/status') return send(200, { tcp: true });
      if (u.pathname === '/api/user/add') {
        if (state.users[json.username]) return fail(400, `User ${json.username} already exists`);
        if (json.password !== json.confirm_password) return fail(400, 'Passwords do not match');
        state.users[json.username] = { password: json.password, active: true, roles: json.roles };
        return send(200, { success: true });
      }
      const user = state.users[json.username || u.searchParams.get('username')];
      if (u.pathname === '/api/users') {
        const q = u.searchParams.get('username');
        return send(200, { results: Object.keys(state.users).filter(n => !q || n.includes(q)).map(n => ({ username: n, active: state.users[n].active })) });
      }
      if (u.pathname === '/api/user/delete') { if (!user) return fail(400, 'not found'); delete state.users[json.username]; state.members = state.members.filter(m => m.username !== json.username); return send(200, { success: true }); }
      if (u.pathname === '/api/user/deactivate') { if (!user) return fail(400, 'does not exist'); if (!user.active) return send(200, { success: false, error: `${json.username} is already deactivated` }); user.active = false; return send(200, { success: true }); }
      if (u.pathname === '/api/user/activate') { if (!user) return fail(400, 'does not exist'); if (user.active) return send(200, { success: false, error: `${json.username} is already activated` }); user.active = true; return send(200, { success: true }); }
      if (u.pathname === '/api/user/password/reset') { if (!user) return fail(400, 'not found'); user.password = json.new_password; return send(200, { success: true }); }
      if (u.pathname === '/api/atak_qr_string' && req.method === 'POST') {
        if (!user) return fail(404, 'No such user');
        state.tokens[json.username] = (state.tokens[json.username] || 0) + 1;
        return send(200, { success: true, qr_string: `tak://com.atakmap.app/enroll?host=tak.example.com:8089&username=${json.username}&token=T${state.tokens[json.username]}` });
      }
      if (u.pathname === '/api/groups' && req.method === 'GET') return send(200, { results: [...state.groups].map((name, i) => ({ name, id: i + 1 })) });
      if (u.pathname === '/api/groups' && req.method === 'POST') {
        if (state.groups.has(json.name)) return fail(400, `${json.name} group already exists`);
        state.groups.add(json.name);
        return send(200, { success: true });
      }
      if (u.pathname === '/api/groups' && req.method === 'PUT') {
        if (!state.groups.has(json.group_name)) return fail(400, 'Group does not exist');
        for (const n of json.users) {
          if (!state.users[n]) return fail(400, `User ${n} does not exist`);
          if (!state.members.some(m => m.username === n && m.group === json.group_name && m.direction === json.direction)) state.members.push({ username: n, group: json.group_name, direction: json.direction });
        }
        return send(200, { success: true });
      }
      if (u.pathname === '/api/groups/members' && req.method === 'DELETE') {
        const p = u.searchParams;
        state.members = state.members.filter(m => !(m.username === p.get('username') && m.group === p.get('group_name') && m.direction === p.get('direction')));
        return send(200, { success: true });
      }
      if (u.pathname === '/api/users/groups') {
        if (!user) return fail(404, 'not found');
        return send(200, { success: true, results: state.members.filter(m => m.username === u.searchParams.get('username')).map(m => ({ group_name: m.group, direction: m.direction, active: true })) });
      }
      if (u.pathname === '/api/eud') {
        const un = u.searchParams.get('username');
        return send(200, { results: state.euds.filter(e => !un || e.username === un) });
      }
      if (u.pathname === '/api/users/all') {
        return send(200, Object.entries(state.users).map(([n, x]) => ({
          username: n, active: x.active, roles: (x.roles || ['user']).map(name => ({ name })),
          group_memberships: state.members.filter(m => m.username === n).map(m => ({ group_name: m.group, direction: m.direction, enabled: true })),
          euds: state.euds.filter(e => e.username === n).map(e => ({ uid: e.uid, callsign: e.callsign })),
        })));
      }
      if (u.pathname === '/api/user/role' && req.method === 'POST') { if (!user) return fail(400, 'not found'); user.roles = json.roles; return send(200, { success: true }); }
      if (u.pathname === '/api/groups' && req.method === 'DELETE') {
        const n = u.searchParams.get('group_name');
        if (!state.groups.has(n)) return fail(404, 'not found');
        state.groups.delete(n);
        state.members = state.members.filter(m => m.group !== n);
        return send(200, { success: true });
      }
      const groupList = () => [...state.groups].map((name, i) => ({ name, id: i + 1 }));
      if (u.pathname === '/api/missions' && req.method === 'GET') return send(200, { results: Object.values(state.missions).map(m => ({ ...m, password_protected: !!m.password, uids: [], contents: [], groups: groupList().filter(g => m.groups.includes(g.id)) })) });
      if (u.pathname === '/api/missions' && req.method === 'PUT') {
        const m = state.missions[json.name];
        if (!m || !json.creator_uid) return fail(400, 'Please provide a mission name and creator UID');
        if (json.groups && json.groups.length) m.groups = json.groups;
        return send(200, { success: true });
      }
      if (u.pathname === '/api/missions' && req.method === 'POST') {
        if (!json.name || !json.creator_uid) return fail(400, 'Please provide a mission name and creator UID');
        if (!state.euds.some(e => e.uid === json.creator_uid)) return fail(400, 'Invalid UID: ' + json.creator_uid);
        state.missions[json.name] = { name: json.name, description: json.description, creator_uid: json.creator_uid, password: json.password || '', groups: json.groups || [], tool: json.tool };
        return send(200, { success: true });
      }
      if (u.pathname === '/api/missions' && req.method === 'DELETE') { delete state.missions[u.searchParams.get('name')]; return send(200, { success: true }); }
      if (u.pathname === '/api/meshtastic/generate_psk') return send(200, { success: true, psk: 'PSK' + state.mesh.length + 'xyz' });
      if (u.pathname === '/api/meshtastic/channel' && req.method === 'GET') return send(200, { results: state.mesh });
      if (u.pathname === '/api/meshtastic/channel' && req.method === 'POST') {
        const url = json.url || 'https://meshtastic.org/e/#' + Buffer.from(JSON.stringify([json.name, json.psk, json.modem_preset])).toString('base64url');
        state.mesh.push({ ...json, url });
        return send(200, { success: true });
      }
      if (u.pathname === '/api/meshtastic/channel' && req.method === 'DELETE') { state.mesh = state.mesh.filter(c => c.url !== u.searchParams.get('url')); return send(200, { success: true }); }
      if (u.pathname === '/api/profiles' && req.method === 'POST') {
        state.profiles = state.profiles.filter(p => !(p.eud_uid === json.eud_uid && p.preference_key === json.preference_key));
        state.profiles.push(json);
        return send(200, { success: true });
      }
      if (u.pathname === '/api/video_streams') {
        return send(200, { results: Object.entries(state.videos).map(([path, v]) => ({ path, mediamtx_settings: JSON.stringify({ source: v.source }) })) });
      }
      if ((u.pathname === '/api/mediamtx/stream/add' && req.method === 'POST') || (u.pathname === '/api/mediamtx/stream/update' && req.method === 'PATCH')) {
        if (!json.path) return fail(400, 'Please specify a path name');
        if (json.path.startsWith('/')) return fail(400, 'Path cannot begin with a slash');
        const add = u.pathname.endsWith('add');
        if (!add && !state.videos[json.path]) return fail(400, `Path ${json.path} not found`);
        if (add && state.videos[json.path]) return fail(400, 'path already exists');
        state.videos[json.path] = { source: json.source, host: req.headers['x-forwarded-host'] || req.headers.host, onDemand: add ? json.sourceOnDemand : (state.videos[json.path] || {}).onDemand };
        return send(200, { success: true });
      }
      if (u.pathname === '/api/mediamtx/stream/delete' && req.method === 'DELETE') {
        const path = u.searchParams.get('path');
        if (!state.videos[path]) return fail(404, 'Video stream not found');
        delete state.videos[path];
        return send(200, { success: true });
      }
      fail(404, 'unknown ' + u.pathname);
    });
  });

  return {
    state,
    listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => server.close(),
    // a user's groups as "GROUP.DIRECTION"
    groupsOf: username => state.members.filter(m => m.username === username).map(m => `${m.group}.${m.direction}`).sort(),
    profileOf: (uid, key) => (state.profiles.find(p => p.eud_uid === uid && p.preference_key === key) || {}).preference_value,
  };
}

module.exports = { createMockOts };
