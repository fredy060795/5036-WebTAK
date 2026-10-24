// Persistent data (admin, SMTP, streams) as a JSON file in the data directory.
// Writes are atomic (temporary file + rename) so a crash never leaves
// a half-written file behind.

const fs = require('fs');
const path = require('path');
const { hashPassword } = require('./passwords');

const DEFAULT_ADMIN = { username: 'admin', password: 'admin123' };

class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'db.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this.load();
  }

  load() {
    if (fs.existsSync(this.file)) {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      data.streams = data.streams || {};
      data.smtp = data.smtp || {};
      return data;
    }
    const data = {
      admin: {
        username: DEFAULT_ADMIN.username,
        password: hashPassword(DEFAULT_ADMIN.password),
        email: '',
        mustChange: true,
      },
      smtp: {},
      streams: {},
    };
    this.write(data);
    return data;
  }

  write(data = this.data) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  save() {
    this.write(this.data);
  }
}

module.exports = { Store, DEFAULT_ADMIN };
