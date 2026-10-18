const assert = require('node:assert/strict');
const {Readable} = require('node:stream');
const test = require('node:test');
const Parser = require('../mail-parser');
function parse(source, options = {}, onAttachment) {
    return new Promise((resolve, reject) => {
        const parser = new Parser(options);
        parser.on('error', reject);
        parser.once('end', resolve);
        if (onAttachment) parser.on('attachment', onAttachment);
        Readable.from([source]).pipe(parser);
    });
}
function multipart(parts) {
    return 'From: =?UTF-8?B?w4k=?= <sender@example.invalid>\r\nTo: recipient@example.invalid\r\nSubject: =?UTF-8?B?w6kgJiAj?=\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=synthetic\r\n\r\n' +
        parts.map(part => '--synthetic\r\n' + part + '\r\n').join('') + '--synthetic--\r\n';
}
const attachment = name => 'Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="' + name + '"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECUERG';
test('maintained parser preserves legacy addresses, Unicode subject and plain body', async () => {
    const mail = await parse(multipart(['Content-Type: text/plain; charset=utf-8\r\n\r\nBody éè']));
    assert.equal(mail.from[0].address, 'sender@example.invalid');
    assert.equal(mail.to[0].address, 'recipient@example.invalid');
    assert.equal(mail.subject, 'é & #'); assert.equal(mail.text.trim(), 'Body éè');
});
test('HTML-only mail remains HTML-only, with missing sender accepted', async () => {
    const mail = await parse('Content-Type: text/html; charset=utf-8\r\n\r\n<p>éè</p>');
    assert.equal(mail.from, undefined); assert.equal(mail.subject, undefined);
    assert.equal(mail.html.trim(), '<p>éè</p>'); assert(!mail.text);
});
test('buffered attachments preserve exact binary data, MIME inference and unique basenames', async () => {
    const mail = await parse(multipart([attachment('../report.pdf'), attachment('../report.pdf')]));
    assert.equal(mail.attachments.length, 2);
    for (const file of mail.attachments) {
        assert.deepEqual(file.content, Buffer.from([0,1,2,80,68,70]));
        assert.equal(file.contentType, 'application/pdf');
        assert(!file.generatedFileName.includes('/'));
    }
    assert.notEqual(mail.attachments[0].generatedFileName, mail.attachments[1].generatedFileName);
});
test('streamed attachments expose consumable legacy streams and finish only after release', async () => {
    const chunks = [];
    const mail = await parse(multipart([attachment('report.pdf')]), {streamAttachments:true}, file => {
        assert(file.stream); assert.equal(file.content, undefined);
        file.stream.on('data', chunk => chunks.push(chunk));
    });
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([0,1,2,80,68,70]));
    assert.equal(mail.attachments[0].size, 6);
});
test('inline image remains an attachment and keeps cid references in HTML', async () => {
    const mail = await parse(multipart([
        'Content-Type: text/html\r\n\r\n<img src="cid:synthetic">',
        'Content-Type: image/png\r\nContent-ID: <synthetic>\r\nContent-Disposition: inline; filename="image.png"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAEC'
    ]));
    assert(mail.html.includes('cid:synthetic'));
    assert.equal(mail.attachments[0].contentId, 'synthetic');
    assert.deepEqual(mail.attachments[0].content, Buffer.from([0,1,2]));
});
