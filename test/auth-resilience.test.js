'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('snapshot migration failure is isolated from successful account authentication', () => {
  assert.match(app, /let snapshotRestoreError = null/);
  assert.match(app, /AUTH\.syncStatus = snapshotRestoreError \? 'error' : 'saved'/);
  assert.match(app, /uploadSnapshot\.chunkedStorageAvailable = false/);
});
