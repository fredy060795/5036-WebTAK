// Nachgebauter OpenTAKServer (nur die Web-API-Teile, die diese App nutzt) für Tests.

const http = require('http');

function createMockOts({ admin = 'otsadmin', password = 'otspass' } = {}) {
  const state = {
    users: {},        // username -> { password, active, roles }
    groups: new Set(),
    members: [],      // { username, group, direction }
    euds: [],         // { uid, callsign, username }
    profiles: [],     // { eud_uid, preference_key, preference_value }
    tokens: {},       // username -> Zähler
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
      if (u.pathname === '/api/groups' && req.method === 'GET') return send(200, { results: [...state.groups].map(name => ({ name })) });
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
      if (u.pathname === '/api/eud') return send(200, { results: state.euds.filter(e => e.username === u.searchParams.get('username')) });
      if (u.pathname === '/api/profiles' && req.method === 'POST') {
        state.profiles = state.profiles.filter(p => !(p.eud_uid === json.eud_uid && p.preference_key === json.preference_key));
        state.profiles.push(json);
        return send(200, { success: true });
      }
      fail(404, 'unknown ' + u.pathname);
    });
  });

  return {
    state,
    listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => server.close(),
    // Gruppen eines Benutzers als "GRUPPE.RICHTUNG"
    groupsOf: username => state.members.filter(m => m.username === username).map(m => `${m.group}.${m.direction}`).sort(),
    profileOf: (uid, key) => (state.profiles.find(p => p.eud_uid === uid && p.preference_key === key) || {}).preference_value,
  };
}

module.exports = { createMockOts };
