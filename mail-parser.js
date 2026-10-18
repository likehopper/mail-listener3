'use strict';
const {Writable} = require('stream');
const {MailParser} = require('mailparser');
const path = require('path');
const mime = require('mime-types');
const {Buffer} = require('buffer');

// Preserve the listener's buffered mail/end and streamed attachment interfaces
// while delegating MIME parsing to maintained mailparser.
module.exports = class ListenerParser extends Writable {
    constructor(options = {}) {
        super({autoDestroy:false});
        const mail = {headers: {}, attachments: []};
        const names = new Set();
        const parser = new MailParser({...options, skipHtmlToText:true, skipTextToHtml:true});
        this.parser = parser;
        parser.on('headers', headers => {
            mail.headers = Object.fromEntries(headers);
            for (const key of ['subject', 'date', 'messageId', 'inReplyTo', 'references', 'priority']) {
                if (headers.has(key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()))) {
                    mail[key] = headers.get(key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()));
                }
            }
            for (const [key, header] of [['from','from'], ['to','to'], ['cc','cc'], ['bcc','bcc'], ['replyTo','reply-to']]) {
                const value = headers.get(header);
                if (value && Array.isArray(value.value)) {
                    mail[key] = value.value.flatMap(address => address.group || [address]);
                }
            }
        });
        parser.on('data', part => {
            if (part.type === 'text') {
                if (typeof part.text === 'string') mail.text = part.text;
                if (typeof part.html === 'string') mail.html = part.html;
                return;
            }
            if (part.type !== 'attachment') return;
            const attachment = {...part};
            delete attachment.type;
            delete attachment.release;
            const basename = path.basename((part.filename || 'attachment').replace(/\\/g, '/'));
            let generated = !basename || basename === '.' || basename === '..' ? 'attachment' : basename;
            let suffix = 1;
            const extension = path.extname(generated);
            const stem = generated.slice(0, generated.length - extension.length);
            while (names.has(generated)) generated = stem + '-' + (++suffix) + extension;
            names.add(generated);
            attachment.fileName = part.filename;
            attachment.generatedFileName = generated;
            attachment.contentId = part.cid || part.contentId;
            if (attachment.contentType === 'application/octet-stream') {
                attachment.contentType = mime.lookup(generated) || attachment.contentType;
            }
            mail.attachments.push(attachment);
            part.content.on('error', error => this.destroy(error));
            const release = () => {
                attachment.size = part.size;
                attachment.checksum = part.checksum;
                part.release();
            };
            if (options.streamAttachments) {
                attachment.stream = part.content;
                delete attachment.content;
                part.content.once('end', release);
                this.emit('attachment', attachment);
            } else {
                const chunks = [];
                part.content.on('data', chunk => chunks.push(chunk));
                part.content.once('end', () => { attachment.content = Buffer.concat(chunks); release(); });
            }
        });
        parser.once('end', () => { if (!this.destroyed) { this.emit('end', mail); this.destroy(); } });
        parser.on('error', error => this.destroy(error));
    }
    _write(chunk, encoding, callback) { this.parser.write(chunk, encoding, callback); }
    _final(callback) { this.parser.end(callback); }
    _destroy(error, callback) {
        if (!this.parser.destroyed) this.parser.destroy();
        callback(error);
    }
};
