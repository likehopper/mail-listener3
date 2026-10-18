const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function setup(directory, uniqueFilenames, crypto = require('crypto')) {
  const parsers = [];
  class Parser extends EventEmitter { constructor() {super(); parsers.push(this);} }
  class Imap extends EventEmitter {
    connect() {} end() {}
    search(filter, callback) {callback(null, [1]);}
    fetch() {
      const result = new EventEmitter();
      setImmediate(() => {
        const message = new EventEmitter();
        result.emit('message', message, 1);
        message.emit('attributes', {uid:1});
        parsers.shift().emit('end', this.nextMail);
      });
      return result;
    }
  }
  const context = {module:{exports:{}}, require(name) {
    if(name === 'imap') return Imap;
    if(name === './mail-parser') return Parser;
    if(name === 'crypto') return crypto;
    if(name === 'async') return {each(items, iterator, done) {
      let remaining = items.length;
      if(!remaining) return done();
      for(const item of items) iterator(item, error => {assert.ifError(error); if(!--remaining) done();});
    }};
    return require(name);
  }, setTimeout, clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../index.js'),'utf8'), context);
  const listener = new context.module.exports({attachments:true, attachmentOptions:{directory,uniqueFilenames}});
  const errors = [];
  listener.on('error', error => errors.push(error));
  listener.start();
  return {errors, async receive(content, name='report.pdf') {
    listener.imap.nextMail = {attachments:[{generatedFileName:name,content:Buffer.from(content)}]};
    const delivered = new Promise(resolve => listener.once('mail', resolve));
    listener.imap.emit('mail');
    return (await delivered).attachments[0];
  }};
}

test('opt-in unique files preserve same-named attachments across mail and listener restarts', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mail-listener-attachments-'));
  try {
    const s=setup(dir,true);
    const first=await s.receive('first');
    const second=await s.receive('second');
    const third=await setup(dir,true).receive('third');
    assert.notEqual(first.path,second.path);
    assert.notEqual(second.path,third.path);
    for(const [attachment,content] of [[first,'first'],[second,'second'],[third,'third']]) {
      assert.equal(fs.readFileSync(attachment.path,'utf8'),content);
      assert.equal(path.dirname(attachment.path),dir);
      assert(attachment.path.endsWith('-report.pdf'));
      assert.equal(attachment.generatedFileName,'report.pdf');
    }
    assert.equal(s.errors.length,0);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('exclusive creation refuses a forced random-name collision without overwriting', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mail-listener-attachments-'));
  try {
    const s=setup(dir,true,{randomBytes(size, callback) {callback(null,Buffer.alloc(size,1));}});
    const first=await s.receive('original');
    const second=await s.receive('replacement');
    assert.equal(second.path,undefined);
    assert.equal(s.errors.length,1);
    assert.equal(s.errors[0].code,'EEXIST');
    assert.equal(fs.readFileSync(first.path,'utf8'),'original');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('random generation failure leaves attachment without a successful path', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mail-listener-attachments-'));
  try {
    const s=setup(dir,true,{randomBytes(size, callback) {callback(new Error('synthetic entropy failure'));}});
    assert.equal((await s.receive('content')).path,undefined);
    assert.equal(s.errors.length,1);
    assert.deepEqual(fs.readdirSync(dir),[]);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('default naming remains unchanged for existing consumers', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mail-listener-attachments-'));
  try {
    const s=setup(dir+path.sep,undefined);
    const attachment=await s.receive('legacy');
    assert.equal(attachment.path,path.join(dir,'report.pdf'));
    assert.equal(fs.readFileSync(attachment.path,'utf8'),'legacy');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('concurrent listeners keep every same-named file inside the download directory', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mail-listener-attachments-'));
  try {
    const saved=await Promise.all(Array.from({length:8},(_,i)=>setup(dir,true).receive('content-'+i,'../report.pdf')));
    assert.equal(new Set(saved.map(attachment=>attachment.path)).size,8);
    for(const [i,attachment] of saved.entries()) {
      assert.equal(path.dirname(attachment.path),dir);
      assert.equal(fs.readFileSync(attachment.path,'utf8'),'content-'+i);
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('an unavailable directory emits an error without a successful attachment path', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mail-listener-attachments-'));
  try {
    const s=setup(path.join(dir,'missing'),true);
    assert.equal((await s.receive('content')).path,undefined);
    assert.equal(s.errors.length,1);
    assert.equal(s.errors[0].code,'ENOENT');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

for (const name of ['a'.repeat(240)+'.pdf', 'é'.repeat(115)+'.pdf', '📄'.repeat(60)+'.pdf']) {
  test('unique filenames fit the byte limit without splitting Unicode: '+Buffer.byteLength(name)+' bytes', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mail-listener-attachments-'));
    try {
      const s=setup(dir,true);
      const attachment=await s.receive('long-name content',name);
      assert.equal(s.errors.length,0,'Long file name must not fail with ENAMETOOLONG');
      assert.equal(attachment.generatedFileName,name,'Original parser filename metadata must remain unchanged');
      assert(Buffer.byteLength(path.basename(attachment.path))<=255);
      assert(attachment.path.endsWith('.pdf'));
      assert(!attachment.path.includes('\uFFFD'),'Truncation must not split a UTF-8 character');
      assert.equal(fs.readFileSync(attachment.path,'utf8'),'long-name content');
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });
}

test('byte boundary, extensionless names and oversized suffixes stay within the limit',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mail-listener-attachments-'));
 try {
  const s=setup(dir,true);const boundary='a'.repeat(218)+'.pdf';
  for(const name of [boundary,'x'.repeat(300),'file.'+'x'.repeat(300)]){
   const attachment=await s.receive('boundary content',name);
   assert.equal(s.errors.length,0);
   assert(Buffer.byteLength(path.basename(attachment.path))<=255);
   if(name===boundary)assert.equal(path.basename(attachment.path).slice(33),name,'An already fitting name must remain exact');
   assert.equal(fs.readFileSync(attachment.path,'utf8'),'boundary content');
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
