// Prints the books for the cover maker (scripts/covers/make.py): [{ id, title, author, tag }] from BOOK_SUMMARIES.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const s = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
const m = /const BOOK_SUMMARIES=(\[[\s\S]*?\n\]);/.exec(s); if (!m) throw new Error('BOOK_SUMMARIES not found');
const arr = vm.runInNewContext('(' + m[1].replace(/\\\\/g, '\\') + ')', {}, { timeout: 5000 });
process.stdout.write(JSON.stringify(arr.map(b => ({ id: b.id, title: b.title, author: b.author, tag: b.tag }))));
