// The narration voice's identity: a hash of voice.json (engines, settings and the recipe of Bro's voice sample). A new
// voice → every note is read again.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const voiceId = dir => crypto.createHash('sha1').update(JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'voice.json'), 'utf8')))).digest('hex').slice(0, 12);
module.exports = { voiceId };
